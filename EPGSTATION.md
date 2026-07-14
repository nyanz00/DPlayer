# EPGStation customizations

This branch is based on `tsukumijima/DPlayer` v1.32.8 and keeps the EPGStation-specific delta small.

## Added integration APIs

- `controllerAutoHideTime`: configures the controller auto-hide delay.
- `controller_show` and `controller_hide`: synchronize application overlays with DPlayer controls.
- `liveColor`: styles the live indicator independently from the player theme.
- `setTheme(theme, liveColor?)`: updates the player CSS variables at runtime.
- `customControls`: adds application-owned controller buttons without direct DOM manipulation.

## Danmaku stability

Each comment receives its own fixed font size when it is created. Adding a `big` or `small` comment no longer changes the size and width of comments already in flight. Container resize also leaves existing animation destinations unchanged; newly drawn comments use the latest player width.
