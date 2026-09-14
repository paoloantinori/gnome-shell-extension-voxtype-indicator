# voxtype-indicator

A GNOME Shell panel indicator for [voxtype](https://github.com/peteonrails/voxtype),
the push-to-talk dictation daemon for Linux.

The icon mirrors the daemon state live:

| Icon | Meaning |
|---|---|
| dim microphone | idle, ready to dictate |
| red microphone | recording (push-to-talk held) |
| orange hourglass | transcription in progress |

Clicking the icon opens a menu with a state line, a dictation start/stop
toggle (uses the daemon's `record toggle` command), a one-click daemon
restart, and a shortcut to open the voxtype configuration file.

## How it works

The extension watches the daemon state file
(`$XDG_RUNTIME_DIR/voxtype/state`, the same file voxtype writes for its
Waybar integration) with a file monitor. No polling, no daemon of its own.

At login the state file may not exist yet (the shell loads extensions just
before the daemon creates it), so the monitor setup retries every 2 seconds
until it succeeds. Without this retry, GNOME could mark the extension as
errored during a lost race and silently disable it.

## Requirements

- GNOME Shell 48, 49 or 50 (Linux; the voxtype daemon with its
  `state_file = "auto"` setting must be running)
- No other dependency: the menu actions call `voxtype` and `systemctl
  --user` which are already part of a voxtype setup

## Install (local)

```
mkdir -p ~/.local/share/gnome-shell/extensions/voxtype-indicator@bird
cp extension.js metadata.json ~/.local/share/gnome-shell/extensions/voxtype-indicator@bird/
```

Then log out and back in (Wayland reloads extension code only at session
start) and enable it:

```
gnome-extensions enable voxtype-indicator@bird
```

To keep it enabled across sessions even if GNOME auto-disables it after a
transient load error, drop this oneshot unit in
`~/.config/systemd/user/voxtype-indicator-enable.service`:

```
[Unit]
Description=Re-assert voxtype-indicator extension at each graphical login

[Service]
Type=oneshot
ExecStart=/usr/bin/gnome-extensions enable voxtype-indicator@bird

[Install]
WantedBy=graphical-session.target
```

and `systemctl --user enable --now voxtype-indicator-enable.service`.

## Publishing on extensions.gnome.org

The extension follows the standard EGO layout (metadata.json with
shell-version range, single extension.js, no imports outside
`resource:///org/gnome/shell`). Before submitting, review the
[EGO submission guidelines](https://extensions.gnome.org/about/) and
consider renaming the uuid (current: `voxtype-indicator@bird`) to match
your account.

## License

MIT
