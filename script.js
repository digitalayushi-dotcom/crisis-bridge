import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref, push, serverTimestamp, get } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-database.js";

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

// ─── HOTEL ID (Smart Memory for PWA) ──────────────
const params = new URLSearchParams(window.location.search);
let hotelId = params.get('hotelId');

if (hotelId) {
    localStorage.setItem('saved_hotel_id', hotelId);
} else {
    hotelId = localStorage.getItem('saved_hotel_id');
}

if (!hotelId) {
    document.addEventListener('DOMContentLoaded', () => {
        const msg = document.getElementById('statusMessage');
        if (msg) {
            msg.innerText = 'Open this page via your Watchtower guest link.';
            msg.className = 'message-warning';
        }
        const btn = document.getElementById('sosTrigger');
        if (btn) btn.disabled = true;
    });
}

const sosBtn = document.getElementById('sosTrigger');
const statusMessage = document.getElementById('statusMessage');
const primaryContainer = document.getElementById('primaryButtonContainer');
const offlineMenu = document.getElementById('offlineMenu');
const backToSosBtn = document.getElementById('backToSos');

// ─── ONBOARDING ───────────────────────────────────
const onboardingOverlay = document.getElementById('onboardingOverlay');
const mainApp = document.getElementById('mainApp');
const slides = document.querySelectorAll('.slide');
const dots = document.querySelectorAll('.dot');
const nextBtn = document.getElementById('nextBtn');
let currentSlide = 0;

if (localStorage.getItem('cb_onboarded') === 'true') {
    onboardingOverlay.classList.add('hidden');
    mainApp.style.display = 'flex';
} else {
    onboardingOverlay.classList.remove('hidden');
    nextBtn.addEventListener('click', () => {
        if (currentSlide < slides.length - 1) {
            slides[currentSlide].classList.remove('active');
            slides[currentSlide].classList.add('hidden');
            dots[currentSlide].classList.remove('active');
            currentSlide++;
            slides[currentSlide].classList.add('active');
            slides[currentSlide].classList.remove('hidden');
            dots[currentSlide].classList.add('active');
            if (currentSlide === slides.length - 1) nextBtn.innerText = 'Get Started';
        } else {
            localStorage.setItem('cb_onboarded', 'true');
            onboardingOverlay.classList.add('hidden');
            mainApp.style.display = 'flex';
        }
    });
}

// ─── LOAD HOTEL NAME + CONTACTS ───────────────────
async function setupHotel() {
    try {
        // Load hotel profile to show name
        const profileSnap = await get(ref(database, `hotels/${hotelId}/profile`));
        if (profileSnap.exists()) {
            const name = profileSnap.val().hotelName;
            const nameEl = document.getElementById('hotelDisplayName');
            if (nameEl && name) nameEl.textContent = name;
        }

        // Load emergency contacts
        const contactsSnap = await get(ref(database, `hotels/${hotelId}/emergency_contacts`));
        if (contactsSnap.exists()) {
            const d = contactsSnap.val();
            if (d.security) document.querySelector('.security-btn').href = `tel:${d.security}`;
            if (d.medical) document.querySelector('.medical-btn').href = `tel:${d.medical}`;
            if (d.fire) document.querySelector('.fire-btn').href = `tel:${d.fire}`;
            if (d.maintenance) document.querySelector('.maint-btn').href = `tel:${d.maintenance}`;
        }
    } catch (e) {
        console.warn('Could not load hotel data:', e);
    }
}

setupHotel();

// ─── BACK TO SOS ──────────────────────────────────
backToSosBtn.addEventListener('click', () => {
    offlineMenu.classList.add('hidden');
    primaryContainer.classList.remove('hidden');
    statusMessage.innerText = 'Ready to assist';
    statusMessage.className = 'message-default';
});

// ─── SOS BUTTON ───────────────────────────────────
sosBtn.addEventListener('click', () => {

    // Offline check
    if (!navigator.onLine) {
        primaryContainer.classList.add('hidden');
        offlineMenu.classList.remove('hidden');
        statusMessage.innerText = 'No internet. Tap a button above to call directly.';
        statusMessage.className = 'message-warning';
        return;
    }

    statusMessage.innerText = 'Acquiring secure location...';
    statusMessage.className = 'message-default';
    sosBtn.disabled = true;

    if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;

                push(ref(database, `hotels/${hotelId}/active_alerts`), {
                    latitude: lat,
                    longitude: lng,
                    status: 'unresolved',
                    type: 'SOS ALERT',
                    desc: `Guest distress signal. Coordinates: ${lat.toFixed(4)}, ${lng.toFixed(4)}`,
                    timestamp: serverTimestamp()
                })
                    .then(() => {
                        statusMessage.innerText = '✅ Alert Transmitted. Help is on the way.';
                        statusMessage.className = 'message-success';
                        sosBtn.disabled = false;
                    })
                    .catch((error) => {
                        console.error('Firebase error:', error);
                        statusMessage.innerText = 'Transmission failed. Try again.';
                        statusMessage.className = 'message-warning';
                        sosBtn.disabled = false;
                    });
            },
            (error) => {
                console.warn('Geolocation error:', error.message);
                statusMessage.innerText = 'Location access denied. Please allow GPS.';
                statusMessage.className = 'message-warning';
                sosBtn.disabled = false;
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    } else {
        statusMessage.innerText = 'Your device does not support GPS.';
        statusMessage.className = 'message-warning';
        sosBtn.disabled = false;
    }
});

// ─── NETWORK STATUS ───────────────────────────────
function updateNetworkStatus() {
    const el = document.getElementById('networkStatus');
    if (!el) return;
    el.textContent = navigator.onLine ? 'Systems Online' : 'Offline Mode';
    el.style.color = navigator.onLine ? '#2ecc71' : '#ff7875';
}
window.addEventListener('online', updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);
updateNetworkStatus();

// ─── PWA SERVICE WORKER ───────────────────────────
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
        .then(reg => console.log('SW registered', reg))
        .catch(err => console.warn('SW failed', err));
}
