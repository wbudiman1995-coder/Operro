The province, kabupaten/kota, and kecamatan options in `indonesia-regions.json`
were extracted from `db/wilayah.sql` in
[cahyadsn/wilayah](https://github.com/cahyadsn/wilayah), an MIT-licensed
compilation of Indonesian administrative regions based on Kepmendagri
No. 300.2.2-2138 Tahun 2025. The source file identifies its last edit as
2026-02-13. Source SHA-256:
`C4C3396D9380D4EDEE072AF1D9DFF83573B574D7CD00A6562CF82E200E954031`.

The snapshot contains 38 provinces, 514 cities/regencies, and 7,285 districts.
It is bundled so customer registration never depends on a third-party API at
runtime. Regenerate it with `python apps/web/scripts/extract-indonesia-regions.py
path/to/wilayah.sql` after reviewing upstream administrative updates.

Original data and extraction are available under the upstream MIT license.
MIT License

Copyright (c) 2017-2025 Cahya DSN

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
