/**
 * In-page dialog system — replaces native alert(), confirm(), prompt().
 * Returns Promises so callers can await the result.
 *
 * Usage:
 *   await dialog.alert('Something happened');
 *   const yes = await dialog.confirm('Are you sure?');
 *   const name = await dialog.prompt('Enter name:', 'default');
 *   const yes = await dialog.danger('Delete this?', 'Delete');
 */

let overlay = null;

function getOverlay() {
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'dialog-overlay';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) dismissCurrent(null);
        });
        document.body.appendChild(overlay);
    }
    return overlay;
}

let currentResolve = null;

function dismissCurrent(value) {
    if (currentResolve) {
        currentResolve(value);
        currentResolve = null;
    }
    const ol = getOverlay();
    ol.classList.remove('open');
    // Remove dialog content after transition
    setTimeout(() => { ol.innerHTML = ''; }, 200);
}

function showDialog({ title, message, inputDefault, confirmLabel, cancelLabel, isDanger }) {
    return new Promise((resolve) => {
        // If a dialog is already open, dismiss it
        if (currentResolve) dismissCurrent(null);

        currentResolve = resolve;
        const ol = getOverlay();
        ol.innerHTML = '';

        const box = document.createElement('div');
        box.className = 'dialog-box';

        // Title
        if (title) {
            const h = document.createElement('div');
            h.className = 'dialog-title';
            h.textContent = title;
            box.appendChild(h);
        }

        // Message
        if (message) {
            const p = document.createElement('div');
            p.className = 'dialog-message';
            p.textContent = message;
            box.appendChild(p);
        }

        // Input (for prompt mode)
        let input = null;
        if (inputDefault !== undefined) {
            input = document.createElement('input');
            input.type = 'text';
            input.className = 'dialog-input';
            input.value = inputDefault || '';
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    dismissCurrent(input.value);
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    dismissCurrent(null);
                }
            });
            box.appendChild(input);
        }

        // Buttons
        const btnRow = document.createElement('div');
        btnRow.className = 'dialog-buttons';

        if (cancelLabel !== undefined) {
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn btn-secondary dialog-cancel';
            cancelBtn.textContent = cancelLabel || 'Cancel';
            cancelBtn.addEventListener('click', () => dismissCurrent(input ? null : false));
            btnRow.appendChild(cancelBtn);
        }

        const okBtn = document.createElement('button');
        okBtn.className = isDanger ? 'btn btn-danger dialog-ok' : 'btn btn-primary dialog-ok';
        okBtn.textContent = confirmLabel || 'OK';
        okBtn.addEventListener('click', () => {
            if (input) {
                dismissCurrent(input.value);
            } else {
                dismissCurrent(true);
            }
        });
        btnRow.appendChild(okBtn);

        box.appendChild(btnRow);
        ol.appendChild(box);

        // Keyboard handler for non-input dialogs
        if (!input) {
            const keyHandler = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    dismissCurrent(cancelLabel !== undefined ? false : true);
                    document.removeEventListener('keydown', keyHandler);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    dismissCurrent(true);
                    document.removeEventListener('keydown', keyHandler);
                }
            };
            document.addEventListener('keydown', keyHandler);
            // Clean up when dialog closes
            const origResolve = currentResolve;
            currentResolve = (val) => {
                document.removeEventListener('keydown', keyHandler);
                origResolve(val);
            };
        }

        // Show with animation
        requestAnimationFrame(() => {
            ol.classList.add('open');
            if (input) {
                input.focus();
                input.select();
            } else {
                okBtn.focus();
            }
        });
    });
}

export const dialog = {
    /** Simple notification — single OK button. Returns when dismissed. */
    alert(message, title) {
        return showDialog({ title, message, confirmLabel: 'OK' });
    },

    /** Yes/No confirmation. Returns true or false. */
    confirm(message, { title, confirmLabel = 'OK', cancelLabel = 'Cancel' } = {}) {
        return showDialog({ title, message, confirmLabel, cancelLabel });
    },

    /** Text input. Returns string or null if cancelled. */
    prompt(message, defaultValue = '', { title, confirmLabel = 'OK', cancelLabel = 'Cancel' } = {}) {
        return showDialog({ title, message, inputDefault: defaultValue, confirmLabel, cancelLabel });
    },

    /** Destructive confirmation — red confirm button. Returns true or false. */
    danger(message, { title, confirmLabel = 'Delete', cancelLabel = 'Cancel' } = {}) {
        return showDialog({ title, message, confirmLabel, cancelLabel, isDanger: true });
    },
};
