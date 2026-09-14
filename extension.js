// Voxtype Recording Indicator: watches the voxtype daemon state file
// ($XDG_RUNTIME_DIR/voxtype/state) and mirrors it in the top panel.
// idle -> dim microphone, recording -> red microphone, transcribing -> hourglass.
//
// Click opens a context menu: dictation toggle, daemon restart, open config.
//
// The state file may not exist yet at login (the daemon creates it just
// after the shell loads extensions), so monitor setup retries every 2s
// until it succeeds. Without the retry, one lost race at login got the
// extension auto-disabled by GNOME (incident 2026-09-14).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const STATES = {
    idle: { icon: '\u{1F3A4}', style: 'opacity: 0.45;', label: 'in attesa' },
    recording: { icon: '\u{1F3A4}', style: 'color: #ff3b30; font-weight: bold;', label: 'registrazione in corso' },
    transcribing: { icon: '\u{23F3}', style: 'color: #ff9f0a;', label: 'trascrizione sul Mac' },
    stopped: { icon: '\u{1F3A4}', style: 'opacity: 0.45;', label: 'in attesa' },
};

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
            return false;   // state dir not there yet
        }
        return true;
    }

    _update() {
        let state = 'idle';
        try {
            const [, contents] = this._file.load_contents(null);
            state = new TextDecoder().decode(contents).trim();
        } catch (e) {
            state = 'idle'; // daemon not running / state file absent
        }
        const s = STATES[state] ?? STATES.idle;
        this._label.text = s.icon;
        this._label.set_style(s.style);
        if (this._stateItem) {
            this._stateItem.label.set_text(`Voxtype: ${s.label}`);
        }
    }
}
