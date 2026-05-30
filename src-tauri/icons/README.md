# App icons

Tauri requires the icon files referenced in `tauri.conf.json` (`32x32.png`,
`128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`) to exist before
`cargo tauri build`.

Generate the full set from a single square source image (1024×1024 PNG
recommended) with the Tauri CLI:

```bash
cargo tauri icon path/to/bowtie-logo.png
```

This writes all required sizes into this directory. The binary icon files are
**not committed** — generate them on the build machine.
