# Regenerating the architecture diagram

`architecture.svg` and `architecture.png` are generated from the official [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/) package, which isn't stored in this repository.

1. Download and unzip the icon package. Its top folder contains `Architecture-Service-Icons_*`, `Resource-Icons_*` and `Architecture-Group-Icons_*`. If the date suffix in those names differs from `07312026`, update the three folder names at the top of `make-diagram.py`.
2. Edit the layout in `make-diagram.py`. Positions are pixel coordinates on a 1720 × 1100 canvas.
3. Render:

```bash
python3 docs/images/src/make-diagram.py /path/to/icon-package docs/images/architecture.svg
npm install --no-save playwright && npx playwright install chromium   # once
node docs/images/src/render-png.js docs/images/architecture.svg docs/images/architecture.png 1720 1100
```

The README shows the PNG, because GitHub renders it the same everywhere. The SVG is self-contained (icons embedded) and scales without blurring, for slides or documents.
