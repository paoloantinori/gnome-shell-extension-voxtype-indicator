// Voxtype Recording Indicator + Control Panel
// Watches the daemon state file, shows a panel icon, and exposes
// feature toggles and profile selection in the click menu.
//
// Toggles (punctuation, filler removal, auto-submit) write the config
// and restart the daemon (2-3s with cached model).
// Profiles use voxtype's profile system (no restart needed: the selected
// profile becomes the default; modifier keys give quick access).
//
// State-change notifications replace each other (single transient
// notification that updates and disappears on idle).

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
    recording: { icon: '\u{1F3A4}', style: 'color: #ff3b30; font-weight: bold;', label: 'registrazione' },
    streaming: { icon: '\u{23FA}', style: 'color: #ff3b30; font-weight: bold;', label: 'streaming' },
    transcribing: { icon: '\u{23F3}', style: 'color: #ff9f0a;', label: 'trascrizione' },
};

const ENDPOINT = 'http://mac.lan:3900';
const CONFIG = '/home/pantinor/.config/voxtype/config.toml';

// Toggle definitions: [config_key, menu_label, config_section]
const TOGGLES = [
    ['spoken_punctuation', 'Punteggiatura parlata', 'text'],
    ['filter_filler_words', 'Rimuovi filler', 'text'],
    ['auto_submit', 'Auto-invio (Enter)', 'output'],
];

const PROFILES = [
    ['none', 'Normale (raw, veloce)'],
    ['clean', 'Pulito (LLM cleanup)'],
    ['translate', 'Tradotto (inglese)'],
    ['formal', 'Formale (professionale)'],
];

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
        this._activeProfile = 'none';

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
        this._readConfigState();
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

        // --- Status section ---
        this._stateItem = new PopupMenu.PopupMenuItem('Voxtype: in attesa', {
            reactive: false,
        });
        menu.addMenuItem(this._stateItem);

        this._daemonItem = new PopupMenu.PopupMenuItem('Demone: controllo...', {
            reactive: false,
        });
        menu.addMenuItem(this._daemonItem);

        this._endpointItem = new PopupMenu.PopupMenuItem('Mac: controllo...', {
            reactive: false,
        });
        menu.addMenuItem(this._endpointItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- Feature toggles ---
        this._toggleItems = {};
        for (const [key, label] of TOGGLES) {
            const item = new PopupMenu.PopupSwitchMenuItem(label, false);
            item.connect('toggled', (item, state) => {
                this._setConfig(key, state);
            });
            menu.addMenuItem(item);
            this._toggleItems[key] = item;
        }
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- Profile selector ---
        const profileLabel = new PopupMenu.PopupMenuItem('Profilo:', {
            reactive: false,
        });
        profileLabel.label.set_style('font-weight: bold; opacity: 0.7;');
        menu.addMenuItem(profileLabel);

        this._profileItems = {};
        for (const [id, label] of PROFILES) {
            const item = new PopupMenu.PopupMenuItem(`  ${label}`);
            item.connect('activate', () => {
                this._setProfile(id);
            });
            menu.addMenuItem(item);
            this._profileItems[id] = item;
        }
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- Actions ---
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
            this._spawn(`xdg-open ${CONFIG}`);
        });
        menu.addMenuItem(openConf);

        // Refresh on menu open
        menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._checkHealth();
                this._readConfigState();
            }
        });
    }

    _readConfigState() {
        // Read current toggle states from config
        try {
            const [, contents] = Gio.File.new_for_path(CONFIG).load_contents(null);
            const text = new TextDecoder().decode(contents);
            for (const [key] of TOGGLES) {
                const match = text.match(new RegExp(`^${key}\\s*=\\s*(true|false)`, 'm'));
                if (match && this._toggleItems[key]) {
                    this._toggleItems[key].setToggleState(match[1] === 'true');
                }
            }
        } catch (e) {
            // Config not readable
        }
    }

    _setConfig(key, value) {
        // Write config change and restart daemon
        const val = value ? 'true' : 'false';
        this._spawn(
            `sed -i 's/^${key}\\s*=\\s*\\(true\\|false\\)/${key} = ${val}/' ${CONFIG} && ` +
            'systemctl --user restart voxtype-dev.service'
        );
        // Brief feedback
        this._showTransient(`Voxtype: ${key} = ${val}, riavvio...`);
    }

    _setProfile(id) {
        this._activeProfile = id;
        this._updateProfileUI();

        if (id === 'none') {
            // Remove post_process command
            this._spawn(
                `sed -i '/^command\\s*=/d; /^timeout_ms\\s*=/d' ${CONFIG} && ` +
                `sed -i '/^\\[output\\.post_process\\]/,/^$/d' ${CONFIG}`
            );
        } else {
            // Set the appropriate post_process command for the profile
            const commands = {
                clean: this._llmCommand('Ripulisci questo dettato italiano. Correggi grammatica, rimuovi ripetizioni e filler. Scrivi SOLO il testo pulito:'),
                translate: this._llmCommand('Translate this Italian text to English. Output ONLY the translation:'),
                formal: this._llmCommand('Riscrivi questo testo italiano in tono formale e professionale. Mantieni il significato. Scrivi SOLO il testo riscritto:'),
            };
            const cmd = commands[id];
            if (cmd) {
                this._spawn(
                    `sed -i '/^\\[output\\.post_process\\]/,/^$/d' ${CONFIG} && ` +
                    `printf '\\n[output.post_process]\\ncommand = "${cmd}"\\ntimeout_ms = 15000\\n' >> ${CONFIG}`
                );
            }
        }
        // Restart daemon to pick up the change
        this._spawn('systemctl --user restart voxtype-dev.service');
        this._showTransient(`Voxtype: profilo ${id}, riavvio...`);
    }

    _llmCommand(instruction) {
        // Build a curl command that posts to the local litellm router
        const escaped = instruction.replace(/"/g, '\\"');
        return `curl -s -m 12 -X POST http://127.0.0.1:4100/v1/messages -H 'Content-Type: application/json' -H 'x-api-key: dummy' -d '{\\"model\\":\\"glm-5.3-flash\\",\\"max_tokens\\":1000,\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"${escaped}\\\\n\\\\n\\"}]}' | jq -r '.content[0].text'`;
    }

    _updateProfileUI() {
        for (const [id] of PROFILES) {
            const item = this._profileItems[id];
            if (item) {
                if (id === this._activeProfile) {
                    item.label.set_text(`● ${PROFILES.find(p => p[0] === id)[1]}`);
                    item.label.set_style('font-weight: bold;');
                } else {
                    item.label.set_text(`  ${PROFILES.find(p => p[0] === id)[1]}`);
                    item.label.set_style('');
                }
            }
        }
    }

    _checkHealth() {
        this._spawnAsync(
            'pgrep -x voxtype-dev >/dev/null && ' +
            'echo "Demone: attivo (pid $(pgrep -x voxtype-dev | head -1))" || ' +
            'echo "Demone: FERMO"',
            (stdout) => this._daemonItem.label.set_text(stdout.trim())
        );
        this._spawnAsync(
            `curl -s -m 3 ${ENDPOINT}/health 2>/dev/null | ` +
            'grep -o \'"status":"[^"]*"\' | cut -d\\" -f4 | ' +
            'xargs -I{} echo "Mac omnivoice: {}" || ' +
            'echo "Mac omnivoice: NON RAGGIUNGIBILE"',
            (stdout) => this._endpointItem.label.set_text(stdout.trim() || 'Mac: errore')
        );
    }

    _spawnAsync(cmd, callback) {
        const tmp = `/tmp/voxtype-indicator-${Date.now()}`;
        try {
            GLib.spawn_command_line_async(
                `/bin/sh -c '${cmd} > ${tmp} 2>/dev/null'`
            );
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                try {
                    const [, contents] = Gio.File.new_for_path(tmp).load_contents(null);
                    callback(new TextDecoder().decode(contents));
                    Gio.File.new_for_path(tmp).delete(null);
                } catch (e) {
                    // File might not exist yet
                }
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.warn(`voxtype-indicator: ${e}`);
        }
    }

    _spawn(cmd) {
        try {
            GLib.spawn_command_line_async(cmd.replace(/'/g, "'\\''"));
        } catch (e) {
            console.warn(`voxtype-indicator: ${cmd}: ${e}`);
        }
    }

    _showTransient(message) {
        try {
            const source = new MessageTray.SystemNotificationSource();
            Main.messageTray.add(source);
            const notif = new MessageTray.Notification(source, message);
            notif.setTransient(true);
            source.showNotification(notif);
        } catch (e) {
            console.warn(`voxtype-indicator: ${e}`);
        }
    }

    _showStateNotification(state) {
        this._destroyStateNotification();
        if (state === 'idle') return;
        const s = STATES[state] ?? STATES.idle;
        try {
            const source = new MessageTray.SystemNotificationSource();
            Main.messageTray.add(source);
            this._stateNotification = new MessageTray.Notification(
                source, `Voxtype: ${s.label}`);
            this._stateNotification.setTransient(true);
            source.showNotification(this._stateNotification);
        } catch (e) {
            console.warn(`voxtype-indicator: ${e}`);
        }
    }

    _destroyStateNotification() {
        if (this._stateNotification) {
            this._stateNotification.destroy();
            this._stateNotification = null;
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
        if (state !== this._lastState) {
            this._showStateNotification(state);
            this._lastState = state;
        }
    }
}
