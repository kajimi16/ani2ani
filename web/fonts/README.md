# Fonts

## Bundled (SIL Open Font License 1.1)

- `IBMPlexSans-VariableFont_wdth_wght.woff2`
- `IBMPlexSans-Italic-VariableFont_wdth_wght.woff2`
- `IBMPlexSans-LatinExt-VariableFont_wght.woff2`
- `IBMPlexMono-Regular.woff2`
- `IBMPlexMono-Medium.woff2`

IBM Plex, © IBM, licensed under the SIL Open Font License 1.1.
Subsets taken from the reference site so glyph coverage and metrics match.
Self-hosted deliberately: the campus network may not reach a font CDN, and a
webfont that fails mid-screening would reflow the page under the audience.

## Not bundled

`MD Lórien` (Mass-Driver) is a commercial typeface, rented per-use. It is
referenced by name in the font stack, so a machine that already has it installed
will use it, but the files are not redistributed here.

What *is* reproduced is the reference site's own fallback declaration — Georgia
with explicit `size-adjust` / `ascent-override` / `descent-override` values. That
is exactly what the reference renders on any machine lacking MD Lórien, so line
pitch and glyph widths agree between the two sites in the fallback case.
