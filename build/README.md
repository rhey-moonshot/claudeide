# Build resources

electron-builder reads packaging assets from this folder.

## App icon (optional)

Drop a **256×256** (or multi-size) `icon.ico` here as `build/icon.ico` and it
will be used for the installer, the executable, and the Start Menu / desktop
shortcuts. If absent, the default Electron icon is used.

Quick way to make one from the app's hexagon logo (`src/index.html` `.logo` SVG),
on any machine with ImageMagick + rsvg:

```bash
rsvg-convert -w 256 -h 256 logo.svg -o icon.png
magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

Or use any online "PNG → ICO" converter and save the result as `build/icon.ico`.
