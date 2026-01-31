/* app.js */

// CONFIGURATION
// REPLACE THIS URL with your deployed Google Apps Script URL
const GAS_ENDPOINT = "https://script.google.com/macros/s/AKfycbxDgqRfSpUdAqWH5kZoeZ5MM29janJW9GSqjUJHrv0Z09QWL8nDNCGPX66rBQMDSaGaMw/exec";
const TOTAL_BEDS = 9;
const STORAGE_KEY = "EWMS_STATE_V1";

// STATE MANAGEMENT
// The 'beds' array is the Single Source of Truth.
// Indices 0-8 correspond to Bed Numbers 1-9.
let beds =;

/**
 * INITIALIZATION
 * Loads state from local storage or creates fresh state.
 * Starts the rendering loop.
 */
function init() {
    const savedState = localStorage.getItem(STORAGE_KEY);
    
    if (savedState) {
        beds = JSON.parse(savedState);
    } else {
        // Initialize 9 empty beds
        for (let i = 1; i <= TOTAL_BEDS; i++) {
            beds.push({
                id: i,
                status: 'empty',
                patient: null
                // Patient Object Schema:
                // { name, mrn, diagnosis, visitDate, visitTime, timestamp (ms) }
            });
        }
    }

    renderGrid();
    
    // Start the Master Timer Loop
    // Updates the DOM every 1 second
    setInterval(updateTimers, 1000);
}

/**
 * RENDER ENGINE
 * Rebuilds the grid based on the 'beds' array.
 */
function renderGrid() {
    const grid = document.getElementById('ward-grid');
    grid.innerHTML = ''; // Clear current

    beds.forEach(bed => {
        const card = document.createElement('div');
        card.className = `bed-card ${bed.status}`;
        card.onclick = () => handleBedClick(bed.id);

        // Bed Number Overlay
        const bedNum = document.createElement('div');
        bedNum.className = 'bed-number';
        bedNum.innerText = bed.id;
        card.appendChild(bedNum);

        if (bed.status === 'empty') {
            card.innerHTML += `<div><strong>EMPTY</strong><br>Tap to Admit</div>`;
        } else {
            const p = bed.patient;
            card.innerHTML += `
                <div>
                    <h3 class="patient-name">${p.name}</h3>
                    <p class="mrn">MRN: ${p.mrn}</p>
                    <p class="diagnosis">${p.diagnosis}</p>
                    <div class="visit-info">Admitted: ${p.visitTime}</div>
                </div>
                <div class="timer-display" id="timer-${bed.id}">
                    Calculating...
                </div>
            `;
        }
        grid.appendChild(card);
    });
    
    // Force immediate timer update so user doesn't wait 1s
    updateTimers();
}

/**
 * INTERACTION HANDLER
 * Decides which modal to show based on bed status.
 */
let currentBedId = null; // Tracks which bed is being interacted with

function handleBedClick(bedId) {
    currentBedId = bedId;
    const bed = beds[bedId - 1]; // Array index is ID - 1

    if (bed.status === 'empty') {
        // SCENARIO 1: Empty Bed -> Admission
        document.getElementById('adm-bed-num').innerText = bedId;
        document.getElementById('form-admission').reset();
        document.getElementById('modal-admission').showModal();
    } else {
        // SCENARIO 2: Occupied Bed -> Action Menu
        document.getElementById('act-bed-num').innerText = bedId;
        document.getElementById('act-patient-summary').innerText = 
            `${bed.patient.name} (${bed.patient.mrn})`;
        document.getElementById('modal-actions').showModal();
    }
}

/**
 * ADMISSION LOGIC
 * Triggered when the admission form is submitted.
 */
document.getElementById('form-admission').addEventListener('submit', (e) => {
    e.preventDefault(); // Prevent page reload
    
    const formData = new FormData(e.target);
    const now = new Date();
    
    // Create Patient Object
    const newPatient = {
        name: formData.get('name'),
        mrn: formData.get('mrn'),
        diagnosis: formData.get('diagnosis'),
        visitDate: now.toLocaleDateString(), // e.g., "1/31/2026"
        visitTime: now.toLocaleTimeString(), // e.g., "8:00:00 PM"
        timestamp: now.getTime() // Milliseconds for delta calc
    };

    // Update State
    const bedIndex = currentBedId - 1;
    beds[bedIndex].status = 'occupied';
    beds[bedIndex].patient = newPatient;

    // Persist & Render
    saveState();
    renderGrid();
    closeModal('modal-admission');

    // Sync to Cloud
    syncData("ADMIT", currentBedId, newPatient);
});

/**
 * CHECK OUT / DISCHARGE LOGIC
 * Stops timer, logs duration, clears bed.
 */
function performCheckOut() {
    if(!confirm("Confirm Discharge? This will clear the bed.")) return;

    const bedIndex = currentBedId - 1;
    const patient = beds[bedIndex].patient;
    
    // Calculate final duration for the log
    const duration = formatDuration(Date.now() - patient.timestamp);

    // Sync Discharge Event
    syncData("DISCHARGE", currentBedId, patient, duration);

    // Clear Local State
    beds[bedIndex].status = 'empty';
    beds[bedIndex].patient = null;
    
    saveState();
    renderGrid();
    closeModal('modal-actions');
}

/**
 * TRANSFER LOGIC
 * Moves patient object from one array index to another.
 * Preserves the original 'timestamp' so LOS is accurate.
 */
function openTransferMode() {
    closeModal('modal-actions');
    const modal = document.getElementById('modal-transfer');
    const list = document.getElementById('transfer-target-list');
    list.innerHTML = '';

    // Find empty beds
    const emptyBeds = beds.filter(b => b.status === 'empty');

    if (emptyBeds.length === 0) {
        alert("No empty beds available for transfer!");
        return;
    }

    // Generate buttons for targets
    emptyBeds.forEach(bed => {
        const btn = document.createElement('button');
        btn.innerText = `Move to Bed ${bed.id}`;
        btn.className = 'btn-action';
        btn.style.margin = '5px';
        btn.onclick = () => executeTransfer(currentBedId, bed.id);
        list.appendChild(btn);
    });

    modal.showModal();
}

function executeTransfer(fromId, toId) {
    const fromIndex = fromId - 1;
    const toIndex = toId - 1;

    // 1. Copy patient to new bed
    beds[toIndex].patient = beds[fromIndex].patient;
    beds[toIndex].status = 'occupied';

    // 2. Clear old bed
    beds[fromIndex].patient = null;
    beds[fromIndex].status = 'empty';

    // 3. Sync Transfer Event
    syncData("TRANSFER", fromId, beds[toIndex].patient, null, `To Bed ${toId}`);

    saveState();
    renderGrid();
    closeModal('modal-transfer');
}

/**
 * TEMPORAL ENGINE
 * Calculates and formats elapsed time.
 */
function updateTimers() {
    const now = Date.now();
    
    beds.forEach(bed => {
        if (bed.status === 'occupied') {
            const el = document.getElementById(`timer-${bed.id}`);
            if (el) {
                const diff = now - bed.patient.timestamp;
                el.innerText = formatDuration(diff);
                
                // UX: Color code based on wait time (Triage Logic)
                // > 4 hours = Red, > 2 hours = Orange
                const hours = diff / (1000 * 60 * 60);
                if (hours >= 4) {
                    el.style.backgroundColor = '#ffcdd2'; // Red warning
                    el.style.color = '#b71c1c';
                } else if (hours >= 2) {
                    el.style.backgroundColor = '#ffe0b2'; // Orange warning
                    el.style.color = '#e65100';
                }
            }
        }
    });
}

function formatDuration(ms) {
    // Requirements: dd:hh:mm:ss
    const secondsTotal = Math.floor(ms / 1000);
    const days = Math.floor(secondsTotal / 86400);
    const hours = Math.floor((secondsTotal % 86400) / 3600);
    const minutes = Math.floor((secondsTotal % 3600) / 60);
    const seconds = secondsTotal % 60;

    const pad = (n) => n.toString().padStart(2, '0');
    
    // Only show days if > 0 to save space, or force it if strictly required
    if (days > 0) {
        return `${pad(days)}:${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `00:${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * PERSISTENCE & SYNC
 */
function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(beds));
}

function closeModal(modalId) {
    document.getElementById(modalId).close();
}

function syncData(action, bedId, patient, duration = "", notes = "") {
    const indicator = document.getElementById('connection-status');
    indicator.innerText = "● Syncing...";
    indicator.style.color = "orange";

    const payload = {
        action: action,
        bedId: bedId,
        name: patient.name,
        mrn: patient.mrn,
        diagnosis: patient.diagnosis + (notes? ` (${notes})` : ""),
        visitDate: patient.visitDate,
        visitTime: patient.visitTime,
        duration: duration
    };

    fetch(GAS_ENDPOINT, {
        method: 'POST',
        // CRITICAL: 'no-cors' mode allows the request to be sent to Google
        // without the browser blocking it due to missing Allow-Origin headers.
        // We will NOT get a readable response, but the data will arrive.
        mode: 'no-cors', 
        headers: {
            'Content-Type': 'text/plain'
        },
        body: JSON.stringify(payload)
    })
  .then(() => {
        indicator.innerText = "● System Ready";
        indicator.style.color = "green";
    })
  .catch(err => {
        console.error(err);
        indicator.innerText = "● Sync Failed";
        indicator.style.color = "red";
        // Logic to queue failed requests in localStorage could go here
    });
}

// Start the app
init();
