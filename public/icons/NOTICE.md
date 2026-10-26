# Azure architecture icons

`azure-icons.json` holds the icons the Architecture drawing uses, taken from Microsoft's **Azure architecture icons,
V24** (downloaded 2026-10-26 from https://learn.microsoft.com/azure/architecture/icons/).

Microsoft's terms, in short: the icons may be used in architecture diagrams, training and documentation that show
Azure services; they must not be cropped, flipped, rotated or recoloured, and the service name should sit next to
the icon (each tile shows its type under its name). They are used only inside the drawing and its downloads, never in
the dashboard's own buttons or menus. Microsoft owns them; read the full terms on the page above before reusing them.
Keep this repository private while it ships them (for a public one, ask CnESymbols@microsoft.com first).

The draw.io download does not carry the icon files: draw.io has its own copies (`img/lib/azure2/...`).

To rebuild (for example from a newer set): download and unpack the zip, then run
`node scripts/build-azure-icons.mjs <unpacked folder>`. The script keeps only the icons the tiles use, refuses icons
that embed pictures and stops when a number in the zip names two icons (add it to `PICK` in the script).
