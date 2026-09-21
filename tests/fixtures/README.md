# Image fixtures

`still.heic` / `probe.heic` are synthetic: a generated gradient and a 2x2 colour block,
converted with macOS `sips -s format heic`. No real people, places or GPS.

`still.heic` is 64x32 with EXIF `DateTimeOriginal` (2019:07:14 09:30:05) and Orientation 6,
so a decoder that honours orientation reports 32x64.
`probe.heic` is the smallest decodable HEIC; it is only used to ask a browser whether it can
decode HEVC-coded HEIC at all.

Regenerate with the commands in docs/superpowers/plans/2026-09-22-heic-original-preservation.md
(Task 1). Keep them small: they are committed and loaded into every test run.
