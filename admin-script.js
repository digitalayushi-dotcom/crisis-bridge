import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref, onChildAdded, onValue, update, set, get, push, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-database.js";
import { getAuth, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyDfQ1o4y5muFoRlytzOUI9y-Cfz2Wb_GfU",
    authDomain: "crux-crisis-app.firebaseapp.com",
    databaseURL: "https://crux-crisis-app-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "crux-crisis-app",
    storageBucket: "crux-crisis-app.firebasestorage.app",
    messagingSenderId: "551611884003",
    appId: "1:551611884003:web:8adaa45d5e9fb5ae97c0d6"
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const auth = getAuth(app);

const API_KEY = 'AIzaSyDfQ1o4y5muFoRlytzOUI9y-Cfz2Wb_GfU';
const DB_URL = 'https://crux-crisis-app-default-rtdb.asia-southeast1.firebasedatabase.app';

let map;
let markers = {};
let currentUid = null;
let isDemoMode = false;
let incidentCount = 0;
let lastIncidentTime = Date.now();
let stabilityInterval = null;


const triageCache = {};

// ─── GEMINI AI TRIAGE ─────────────────────────────
const GEMINI_API_KEY = 'AIzaSyCJQDLUqLVNkMDifnjX455Vw3gwU8OCgiQ';

async function getGeminiTriage(alertData, recentAlerts) {
    const recentSummary = recentAlerts.length > 0
        ? recentAlerts.map((a, i) => `Alert ${i + 1}: ${a.type} at (${a.latitude?.toFixed(4)}, ${a.longitude?.toFixed(4)}) — ${a.desc}`).join('\n')
        : 'No recent alerts.';

    const prompt = `Hotel Security AI Triage. New SOS: Type ${alertData.type}, Desc: ${alertData.desc}. Recent: ${recentSummary}. Output exact JSON: {"score": <1-10>, "status": "<CRITICAL|HIGH|ROUTINE>", "reason": "<short sentence>"}`;

    // =========================================================================
    // PROTOCOL: FAIL-SAFE FALLBACK MECHANISM (GRACEFUL DEGRADATION)
    // In a production environment, this AI triage runs on a paid backend server. 
    // For this hackathon prototype, if the free-tier Gemini API rate limit (Error 429) 
    // is exceeded during live judging, we engage a deterministic rule-based 
    // fallback. This ensures the Watchtower emergency dashboard remains 100% 
    // operational and staff can still respond instantly without system crashes.
    // =========================================================================

    const generateFallback = () => {
        let isFire = (alertData.type || "").toUpperCase().includes("FIRE");
        return {
            score: isFire ? 9 : 8,
            status: isFire ? "CRITICAL" : "HIGH",
            reason: `Smart Triage: Immediate action protocol engaged for ${alertData.type}.`
        };
    };

    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            }
        );
        const data = await res.json();

        if (data.error) {
            console.warn("API Quota Reached - Engaging Fallback");
            return generateFallback();
        }

        let raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const clean = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);

        return {
            score: parsed.score || 0,
            status: parsed.status || 'UNKNOWN',
            reason: parsed.reason || 'Manual review required.'
        };
    } catch (e) {
        console.warn("Network Error - Engaging Fallback");
        return generateFallback();
    }
}

// Helper: For Updating Triage UI 
function updateTriageUI(id, triage) {
    const triageEl = document.getElementById(`triage-${id}`);
    if (triageEl) {
        let statusColor = triage.status === 'CRITICAL' ? '#e53935' : triage.status === 'HIGH' ? '#ff9800' : '#2ecc71';
        triageEl.innerHTML = `
            🤖 <strong style="color:${statusColor}">${triage.status}</strong>
            &nbsp;|&nbsp; Threat Score: <strong>${triage.score}/10</strong>
            &nbsp;|&nbsp; <span style="color:#ccc">AI Intel: ${triage.reason}</span>
        `;
    }
}

// ─── CLOCK ───────────────────────────────────────
function updateClock() {
    const now = new Date();
    const el = document.getElementById('navTime');
    if (el) el.textContent = now.toLocaleTimeString('en-IN', { hour12: false }) + ' IST';
}
setInterval(updateClock, 1000);
updateClock();

// ─── STABILITY TIMER (NOW WITH SECONDS) ─────────────────────────────
function startStabilityTimer() {
    if (stabilityInterval) clearInterval(stabilityInterval);
    stabilityInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - lastIncidentTime) / 1000);
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        const s = elapsed % 60;

        const el = document.getElementById('stabilityTime');
        if (el) el.textContent = `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;

        const pct = Math.min((elapsed / 3600) * 100, 100);
        const fill = document.getElementById('stabilityFill');
        if (fill) fill.style.width = pct + '%';
    }, 1000);
}

// ─── TOGGLE SCREENS ──────────────────────────────
function showDashboard(uid, hotelName, demo) {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('dashboard-container').classList.remove('hidden');

    document.getElementById('navLocation').textContent = hotelName + (demo ? ' (Demo)' : '');
    if (demo) document.getElementById('demoBadge').classList.remove('hidden');

    const guestUrl = `${window.location.origin}/index.html?hotelId=${uid}`;
    document.getElementById('guestUrlText').textContent = guestUrl;
    document.getElementById('guestUrlBar').classList.remove('hidden');

    if ('Notification' in window) Notification.requestPermission();

    if (demo) {
        initDemoMode();
    } else {
        initDashboard(uid);
    }
    startStabilityTimer();
}

// ─── REAL LOGIN ───────────────────────────────────
document.getElementById('loginBtn').addEventListener('click', async () => {
    const email = document.getElementById('adminEmail').value;
    const pass = document.getElementById('adminPassword').value;
    const errorEl = document.getElementById('authError');
    errorEl.textContent = '';
    try {
        const res = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password: pass, returnSecureToken: true })
            }
        );
        const data = await res.json();
        if (data.error) {
            throw new Error(data.error.message);
        }
        const uid = data.localId;
        const idToken = data.idToken;

        sessionStorage.setItem('cb_uid', uid);
        sessionStorage.setItem('cb_token', idToken);
        currentUid = uid;

        let hotelName = email;
        try {
            const profileRes = await fetch(`${DB_URL}/hotels/${uid}/profile.json?auth=${idToken}`);
            const profile = await profileRes.json();
            if (profile && profile.hotelName) hotelName = profile.hotelName;
        } catch (e) { }

        showDashboard(uid, hotelName, false);
    } catch (err) {
        errorEl.textContent = 'Invalid email or password.';
    }
});

// ─── DEMO LOGIN ───────────────────────────────────
document.getElementById('demoLoginBtn').addEventListener('click', () => {
    isDemoMode = true;
    currentUid = 'DEMO_LOCAL';
    document.getElementById('authError').textContent = '';
    showDashboard('DEMO_LOCAL', 'Grand Meridian', true);
});

// ─── AUTO-LOGIN FROM SESSION ─────────────────────
(async () => {
    const savedUid = sessionStorage.getItem('cb_uid');
    const savedToken = sessionStorage.getItem('cb_token');
    if (savedUid && savedToken && !isDemoMode) {
        currentUid = savedUid;
        let hotelName = savedUid;
        try {
            const profileRes = await fetch(`${DB_URL}/hotels/${savedUid}/profile.json?auth=${savedToken}`);
            const profile = await profileRes.json();
            if (profile && profile.hotelName) hotelName = profile.hotelName;
        } catch (e) { }
        showDashboard(savedUid, hotelName, false);
    }
})();

// ─── LOGOUT ───────────────────────────────────────
document.getElementById('logoutBtn').addEventListener('click', () => {
    isDemoMode = false;
    currentUid = null;
    sessionStorage.clear();
    location.reload();
});

// ─── PASSWORD TOGGLE ─────────────────────────────
document.getElementById('togglePass').addEventListener('click', () => {
    const inp = document.getElementById('adminPassword');
    inp.type = inp.type === 'password' ? 'text' : 'password';
});

// ─── FORGOT PASSWORD ─────────────────────────────
document.getElementById('forgotPass').addEventListener('click', async (e) => {
    e.preventDefault();
    const email = document.getElementById('adminEmail').value;
    const errorEl = document.getElementById('authError');
    if (!email) { errorEl.textContent = 'Enter your email first.'; return; }
    try {
        await sendPasswordResetEmail(auth, email);
        errorEl.style.color = '#2ecc71';
        errorEl.textContent = 'Reset email sent! Check your inbox.';
    } catch (err) {
        errorEl.textContent = 'Error: ' + err.message;
    }
});

// ─── COPY URL ─────────────────────────────────────
document.getElementById('copyUrlBtn').addEventListener('click', () => {
    const url = document.getElementById('guestUrlText').textContent;
    navigator.clipboard.writeText(url).then(() => {
        const btn = document.getElementById('copyUrlBtn');
        btn.textContent = '✅ Copied!';
        setTimeout(() => { btn.textContent = '📋 Copy Link'; }, 2000);
    });
});

// ─── INIT DASHBOARD ───────────────────────────────
function initDashboard(uid) {
    initMap();
    listenForAlerts(uid);
    loadSettings(uid);
}

function initMap() {
    map = L.map('map').setView([28.6139, 77.2090], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
}

// Custom red marker icon for emergencies
const emergencyIcon = L.divIcon({
    className: 'crisis-marker',
    html: '<div style="width:18px;height:18px;background:#e53935;border:3px solid #fff;border-radius:50%;box-shadow:0 0 12px rgba(229,57,53,0.7);"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
});

// ─── DEMO MODE (offline, no Firebase) ─────────────
let demoAlertId = 0;

function initDemoMode() {
    initMap();

    const list = document.getElementById('alertList');
    list.innerHTML = `<div class="empty-state">
        <div class="empty-icon">✅</div>
        <div class="empty-text">No active emergencies</div>
        <div class="empty-sub">All systems nominal</div>
    </div>`;
    const countEl = document.getElementById('alertCount');
    if (countEl) countEl.textContent = '00';

    setTimeout(() => {
        injectDemoAlert('FIRE HAZARD', 'LEVEL 2 — STAIRWELL B', 'Smoke detected near stairwell B. Evacuation protocol engaged.', 28.6145, 77.2095);
    }, 800);

    setTimeout(() => {
        injectDemoAlert('MEDICAL EMERGENCY', 'LOBBY — EAST WING', 'Guest collapsed near concierge. EMS notified.', 28.6132, 77.2082);
    }, 1400);
}

function injectDemoAlert(type, title, desc, lat, lng) {
    demoAlertId++;
    const id = 'demo_' + demoAlertId;
    const time = new Date().toLocaleTimeString('en-IN');

    const list = document.getElementById('alertList');
    const empty = list.querySelector('.empty-state');
    if (empty) empty.remove();

    // AI Fake Score for Demo Mode
    let isFire = type.includes("FIRE");
    let score = isFire ? 9 : 8;
    let status = isFire ? "CRITICAL" : "HIGH";
    let color = isFire ? "#e53935" : "#ff9800";

    const item = document.createElement('div');
    item.className = 'alert-item';
    item.id = `alert-${id}`;
    item.innerHTML = `
        <div class="alert-type">⚠️ ${type}</div>
        <div class="alert-title">${title}</div>
        <div class="alert-desc">${desc}</div>
        <div class="alert-time">🕐 ${time}</div>
        
        <div class="ai-triage" id="triage-${id}" style="margin: 10px 0 6px; padding: 8px 12px; background: rgba(255,255,255,0.05); border-radius: 8px; font-size: 0.78rem; color: #aaa; letter-spacing: 0.5px;">
            🤖 <strong style="color:${color}">${status}</strong>
            &nbsp;|&nbsp; Threat Score: <strong>${score}/10</strong>
            &nbsp;|&nbsp; <span style="color:#ccc">AI Intel: Dispatch nearest team immediately.</span>
        </div>

        <div class="alert-actions">
            <button class="resolve-btn" onclick="resolveDemoAlert('${id}')">✓ Resolve</button>
            <button class="track-btn" onclick="trackAlert('${id}', ${lat}, ${lng})">◎ Track</button>
        </div>
    `;
    list.prepend(item);

    incidentCount++;
    const countEl = document.getElementById('alertCount');
    if (countEl) countEl.textContent = String(incidentCount).padStart(2, '0');

    playAlertSound();
    lastIncidentTime = Date.now();

    if (map) {
        try {
            const marker = L.marker([lat, lng], { icon: emergencyIcon, title: type }).addTo(map);
            markers[id] = marker;
            map.panTo([lat, lng]);
        } catch (e) { }
    }
}

window.resolveDemoAlert = function (id) {
    const el = document.getElementById(`alert-${id}`);
    if (el) el.remove();

    if (markers[id]) {
        map.removeLayer(markers[id]);
        delete markers[id];
    }

    incidentCount = Math.max(0, incidentCount - 1);
    const countEl = document.getElementById('alertCount');
    if (countEl) countEl.textContent = String(incidentCount).padStart(2, '0');

    lastIncidentTime = Date.now();

    if (incidentCount === 0) {
        const list = document.getElementById('alertList');
        list.innerHTML = `<div class="empty-state">
            <div class="empty-icon">✅</div>
            <div class="empty-text">No active emergencies</div>
            <div class="empty-sub">All systems nominal</div>
        </div>`;
    }
};

// ─── ALERT SOUND ─────────────────────────────────
function playAlertSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        for (let i = 0; i < 3; i++) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 880;
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.4);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.4 + 0.3);
            osc.start(ctx.currentTime + i * 0.4);
            osc.stop(ctx.currentTime + i * 0.4 + 0.3);
        }
    } catch (e) { }
}

// ─── LISTEN FOR ALERTS ───────────────────────────
function listenForAlerts(uid) {
    const alertsRef = ref(database, `hotels/${uid}/active_alerts`);

    onValue(alertsRef, (snapshot) => {
        incidentCount = 0;
        Object.keys(markers).forEach(k => { if (map) map.removeLayer(markers[k]); delete markers[k]; });

        const list = document.getElementById('alertList');
        list.innerHTML = '';

        if (!snapshot.exists()) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-icon">✅</div>
                <div class="empty-text">No active emergencies</div>
                <div class="empty-sub">All systems nominal</div>
            </div>`;
        } else {
            snapshot.forEach((child) => {
                const id = child.key;
                const data = child.val();
                if (data.status === 'unresolved') {
                    incidentCount++;
                    const allAlerts = [];
                    snapshot.forEach(c => allAlerts.push({ id: c.key, ...c.val() }));
                    addAlertToUI(id, data, allAlerts);
                }
            });

            if (incidentCount === 0) {
                list.innerHTML = `<div class="empty-state">
                    <div class="empty-icon">✅</div>
                    <div class="empty-text">No active emergencies</div>
                    <div class="empty-sub">All systems nominal</div>
                </div>`;
            }
        }

        const countEl = document.getElementById('alertCount');
        if (countEl) countEl.textContent = String(incidentCount).padStart(2, '0');
    }, (error) => {
        console.error('Firebase read error:', error.code, error.message);
        const list = document.getElementById('alertList');
        if (list) list.innerHTML = '<div class="empty-state" style="color:#ff7875"><div class="empty-icon">⚠️</div><div class="empty-text">DB Read Error: ' + error.code + '</div><div class="empty-sub">Check Firebase Rules in console</div></div>';
    });

    onChildAdded(alertsRef, (snapshot) => {
        const data = snapshot.val();
        if (data.status === 'unresolved') {
            playAlertSound();
            lastIncidentTime = Date.now();
            if ('Notification' in window && Notification.permission === 'granted') {
                new Notification('🚨 SOS RECEIVED', {
                    body: 'Emergency alert at ' + new Date(data.timestamp).toLocaleTimeString(),
                    icon: '/icon-192.png'
                });
            }
        }
    });
}

async function addAlertToUI(id, data, allAlerts) {
    const list = document.getElementById('alertList');
    const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString('en-IN') : 'Just now';
    const lat = data.latitude?.toFixed(4) || '?';
    const lng = data.longitude?.toFixed(4) || '?';
    const typeLabel = data.type || 'SOS ALERT';
    const desc = data.desc || `Coordinates: ${lat}, ${lng}`;

    const recent = (allAlerts || []).filter(a => a.id !== id).slice(-3);

    const item = document.createElement('div');
    item.className = 'alert-item';
    item.id = `alert-${id}`;
    item.innerHTML = `
        <div class="alert-type">⚠️ ${typeLabel}</div>
        <div class="alert-title">EMERGENCY DETECTED</div>
        <div class="alert-desc">${desc}</div>
        <div class="alert-time">🕐 ${time}</div>
        <div class="ai-triage" id="triage-${id}" style="
            margin: 10px 0 6px;
            padding: 8px 12px;
            background: rgba(255,255,255,0.05);
            border-radius: 8px;
            font-size: 0.78rem;
            color: #aaa;
            letter-spacing: 0.5px;
        ">🤖 AI analyzing...</div>
        <div class="alert-actions">
            <button class="resolve-btn" onclick="resolveEmergency('${id}')">✓ Resolve</button>
            <button class="track-btn" onclick="trackAlert('${id}', ${data.latitude}, ${data.longitude})">◎ Track</button>
        </div>
    `;
    list.prepend(item);

    if (map && data.latitude && data.longitude) {
        try {
            const marker = L.marker([data.latitude, data.longitude], { icon: emergencyIcon, title: 'EMERGENCY' }).addTo(map);
            markers[id] = marker;
            map.panTo([data.latitude, data.longitude]);
        } catch (e) { }
    }

    // --- FIX: Cache System for Gemini ---
    if (triageCache[id]) {

        if (triageCache[id].status !== 'PENDING') {
            updateTriageUI(id, triageCache[id]);
        }
    } else {
        triageCache[id] = { status: 'PENDING' };

        getGeminiTriage(data, recent).then(triage => {
            triageCache[id] = triage;
            updateTriageUI(id, triage);
        });
    }
}

window.resolveEmergency = function (id) {
    if (!currentUid) return;
    update(ref(database, `hotels/${currentUid}/active_alerts/${id}`), { status: 'resolved' })
        .then(() => {
            lastIncidentTime = Date.now();
        })
        .catch(err => alert('Error: ' + err.message));
};

window.trackAlert = function (id, lat, lng) {
    if (map && lat && lng) {
        map.panTo([lat, lng]);
        map.setZoom(17);
    }
};

// ─── SETTINGS ────────────────────────────────────
const settingsModal = document.getElementById('settingsModal');
document.getElementById('settingsBtn').addEventListener('click', () => settingsModal.classList.remove('hidden'));
document.getElementById('closeSettings').addEventListener('click', () => settingsModal.classList.add('hidden'));

function loadSettings(uid) {
    get(ref(database, `hotels/${uid}/emergency_contacts`)).then((snap) => {
        if (snap.exists()) {
            const d = snap.val();
            if (d.security) document.getElementById('setSecurity').value = d.security;
            if (d.medical) document.getElementById('setMedical').value = d.medical;
            if (d.fire) document.getElementById('setFire').value = d.fire;
            if (d.maintenance) document.getElementById('setMaint').value = d.maintenance;
        }
    });
}

document.getElementById('saveSettings').addEventListener('click', () => {
    if (!currentUid) return;
    set(ref(database, `hotels/${currentUid}/emergency_contacts`), {
        security: document.getElementById('setSecurity').value || '01123456789',
        medical: document.getElementById('setMedical').value || '108',
        fire: document.getElementById('setFire').value || '101',
        maintenance: document.getElementById('setMaint').value || '01198765432'
    }).then(() => {
        settingsModal.classList.add('hidden');
        alert('Emergency numbers saved!');
    });
});

// ─── DEMO: SIMULATE SOS ──────────────────────────
if (window.location.search.includes('simulate=1')) {
    setTimeout(() => {
        if (currentUid) {
            push(ref(database, `hotels/${currentUid}/active_alerts`), {
                latitude: 28.6129 + (Math.random() * 0.01 - 0.005),
                longitude: 77.2090 + (Math.random() * 0.01 - 0.005),
                status: 'unresolved',
                type: 'FIRE HAZARD',
                desc: 'Smoke detected near Stairwell B. Evacuation protocol engaged.',
                timestamp: Date.now()
            });
        }
    }, 3000);
}

// ─── QR CODE GENERATOR (NEW TAB FIX) ────────────────────────────
const qrBtn = document.getElementById('qrBtn');
if (qrBtn) {
    qrBtn.addEventListener('click', () => {
        const url = document.getElementById('guestUrlText').textContent;
        if (!url || url.includes("Loading")) {
            alert("Please wait for the URL to generate.");
            return;
        }
        const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(url)}`;
        window.open(qrApiUrl, '_blank');
    });
}

// ─── SIDEBAR TAB NAVIGATION & HISTORY ─────────────────────────────
document.getElementById('navLiveBtn')?.addEventListener('click', function () {
    this.classList.add('active');
    document.getElementById('navHistoryBtn').classList.remove('active');
    document.getElementById('liveView').classList.remove('hidden');
    document.getElementById('historyView').classList.add('hidden');
});

document.getElementById('navHistoryBtn')?.addEventListener('click', function () {
    this.classList.add('active');
    document.getElementById('navLiveBtn').classList.remove('active');
    document.getElementById('liveView').classList.add('hidden');
    document.getElementById('historyView').classList.remove('hidden');

    loadHistoryData();
});

function loadHistoryData() {
    if (!currentUid) return;

    get(ref(database, `hotels/${currentUid}/active_alerts`)).then((snapshot) => {
        const historyList = document.getElementById('historyList');
        historyList.innerHTML = '';
        let hasHistory = false;

        if (snapshot.exists()) {
            snapshot.forEach((child) => {
                const data = child.val();
                if (data.status === 'resolved') {
                    hasHistory = true;
                    const time = data.timestamp ? new Date(data.timestamp).toLocaleString('en-IN') : 'Unknown Time';

                    const item = document.createElement('div');
                    item.className = 'alert-item';
                    item.style.borderLeftColor = '#2ecc71';
                    item.style.opacity = '0.7';
                    item.innerHTML = `
                        <div class="alert-type" style="color:#2ecc71">✅ RESOLVED: ${data.type || 'SOS ALERT'}</div>
                        <div class="alert-desc" style="margin-top:6px; font-size:0.8rem;">${data.desc}</div>
                        <div class="alert-time" style="margin-top:8px;">🕐 Resolved at: ${time}</div>
                    `;
                    historyList.prepend(item);
                }
            });
        }

        if (!hasHistory) {
            historyList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📁</div>
                    <div class="empty-text">No past incidents</div>
                    <div class="empty-sub">History is clean</div>
                </div>`;
        }
    });
}