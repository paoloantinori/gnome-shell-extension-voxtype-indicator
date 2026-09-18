// Voxtype Recording Indicator: watches the voxtype daemon state file
// ($XDG_RUNTIME_DIR/voxtype/state) and mirrors it in the top panel.
// idle -> dim microphone, recording -> red microphone, transcribing -> hourglass.
//
// Click opens a context menu with state info, daemon check, endpoint check,
// dictation toggle, daemon restart, and a config shortcut.
//
// State-change notifications replace each other (one notification that
// updates in place) instead of stacking. The final transcription
// notification (from the daemon) stays separate and persistent.
//
// The state file may not exist yet at login (the daemon creates it just
// after the shell loads extensions), so monitor setup retries every 2s
// until it succeeds. Without this retry, GNOME could mark the extension
// as errored during a lost race and silently disable it.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const STATES = {
    idle: { icon: '\u{1F3A4}', style: 'opacity: 0.45;', label: 'in attesa' },
    recording: { icon: '\u{1F3A4}', style: 'color: #ff3b30; font-weight: bold;', label: 'registrazione in corso' },
    streaming: { icon: '\u{23FA}', style: 'color: #ff3b30; font-weight: bold;', label: 'streaming in corso' },
    transcribing: { icon: '\u{23F3}', style: 'color: #ff9f0a;', label: 'trascrizione sul Mac' },
};

const ENDPOINT = 'http://mac.lan:3900';

export default class VoxtypeIndicatorExtension {
    enable() {
        this._button = new PanelMenu.Button(0.0, 'Voxtype Indicator', true);
        this._label = new St.Label({
            text: STATES.idle.icon,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label.set_style(STATES.idle.style);
        this._button.add_child(this._label);
        Main.panel.addToStatusArea('voxtype-indicator', this._button);
        this._retryId = null;
        this._stateNotification = null;
        this._lastState = 'idle';

        this._file = Gio.File.new_for_path(
            `${GLib.get_user_runtime_dir()}/voxtype/state`);

        this._buildMenu();

        if (!this._setupMonitor()) {
            this._retryId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, 2, () => {
                    if (this._setupMonitor()) {
                        this._retryId = null;
                        return GLib.SOURCE_REMOVE;
                    }
                    return GLib.SOURCE_CONTINUE;
                });
        }
        this._update();
    }

    disable() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = null;
        }
        this._destroyStateNotification();
        if (this._monitorId) {
            this._monitor.disconnect(this._monitorId);
            this._monitorId = null;
        }
        if (this._monitor) {
            this._monitor.cancel();
            this._monitor = null;
        }
        if (this._button) {
            this._button.destroy();
            this._button = null;
        }
        this._label = null;
    }

    _buildMenu() {
        const menu = this._button.menu;

        this._stateItem = new PopupMenu.PopupMenuItem('Voxtype: in attesa', {
            reactive: false,
        });
        menu.addMenuItem(this._stateItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._daemonItem = new PopupMenu.PopupMenuItem('Demone: controllo...', {
            reactive: false,
        });
        menu.addMenuItem(this._daemonItem);

        this._endpointItem = new PopupMenu.PopupMenuItem('Mac: controllo...', {
            reactive: false,
        });
        menu.addMenuItem(this._endpointItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const toggle = new PopupMenu.PopupMenuItem('Detta: avvia / ferma');
        toggle.connect('activate', () => {
            this._spawn('voxtype-dev record toggle');
        });
        menu.addMenuItem(toggle);

        const restart = new PopupMenu.PopupMenuItem('Riavvia demone');
        restart.connect('activate', () => {
            this._spawn('systemctl --user restart voxtype-dev.service');
        });
        menu.addMenuItem(restart);

        const openConf = new PopupMenu.PopupMenuItem('Apri configurazione');
        openConf.connect('activate', () => {
            this._spawn(
                'xdg-open /home/pantinor/.config/voxtype/config.toml');
        });
        menu.addMenuItem(openConf);

        // Refresh health checks when the menu opens
        menu.connect('open-state-changed', (menu, open) => {
            if (open) this._checkHealth();
        });
    }

    _checkHealth() {
        // Daemon check: state file readable + PID alive
        this._spawnAsync(
            'pgrep -x voxtype-dev >/dev/null && ' +
            'echo "Demone: attivo (pid $(pgrep -x voxtype-dev | head -1))" || ' +
            'echo "Demone: FERMO"',
            (stdout) => {
                this._daemonItem.label.set_text(stdout.trim());
            }
        );

        // Endpoint check: quick curl with 3s timeout
        this._spawnAsync(
            `curl -s -m 3 ${ENDPOINT}/health 2>/dev/null | ` +
            'grep -o \'"status":"[^"]*"\' | cut -d\\" -f4 | ' +
            'xargs -I{} echo "Mac omnivoice: {}" || ' +
            'echo "Mac omnivoice: NON RAGGIUNGIBILE"',
            (stdout) => {
                this._endpointItem.label.set_text(stdout.trim() || 'Mac omnivoice: errore');
            }
        );
    }

    _spawnAsync(cmd, callback) {
        try {
            GLib.spawn_command_line_async(
                `/bin/sh -c '${cmd.replace(/'/g, "'\\''")}'`
            );
            // Read result after a short delay (spawn_command_line_async
            // doesn't give us output; use a temp file)
            const tmp = `/tmp/voxtype-indicator-${Date.now()}`;
            GLib.spawn_command_line_async(
                `/bin/sh -c '${cmd} > ${tmp} 2>/dev/null'`
            );
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                try {
                    const [, contents] = Gio.File.new_for_path(tmp).load_contents(null);
                    callback(new TextDecoder().decode(contents));
                    Gio.File.new_for_path(tmp).delete(null);
                } catch (e) {
                    // File might not exist yet or command failed
                }
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.warn(`voxtype-indicator: ${e}`);
        }
    }

    _spawn(cmd) {
        try {
            GLib.spawn_command_line_async(cmd);
        } catch (e) {
            console.warn(`voxtype-indicator: ${cmd}: ${e}`);
        }
    }

    _setupMonitor() {
        try {
            this._monitor = this._file.monitor(
                Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect(
                'changed', () => this._update());
        } catch (e) {
            return false;
        }
        return true;
    }

    _showStateNotification(state) {
        // Replace the previous state notification (don't stack)
        this._destroyStateNotification();

        if (state === 'idle') return; // No notification for idle

        const s = STATES[state] ?? STATES.idle;
        try {
            const source = new MessageTray.SystemNotificationSource();
            Main.messageTray.add(source);
            this._stateNotification = new MessageTray.Notification(
                source, `Voxtype: ${s.label}`);
            this._stateNotification.setTransient(true);
            source.showNotification(this._stateNotification);
        } catch (e) {
            console.warn(`voxtype-indicator: notification: ${e}`);
        }
    }

    _destroyStateNotification() {
        if (this._stateNotification) {
            this._stateNotification.destroy();
            this._stateNotification = null;
        }
    }

    _update() {
        let state = 'idle';
        try {
            const [, contents] = this._file.load_contents(null);
            state = new TextDecoder().decode(contents).trim();
        } catch (e) {
            state = 'idle';
        }
        const s = STATES[state] ?? STATES.idle;
        this._label.text = s.icon;
        this._label.set_style(s.style);
        if (this._stateItem) {
            this._stateItem.label.set_text(`Voxtype: ${s.label}`);
        }

        // Show/replace notification only on state CHANGE
        if (state !== this._lastState) {
            this._showStateNotification(state);
            this._lastState = state;
        }
    }
}
