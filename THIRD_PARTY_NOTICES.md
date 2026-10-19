# Third-party notices

This file records third-party code that obsy reuses or ships. See [Clean-room licensing](docs/concepts/clean-room-licensing.md).

## aws4fetch

- Used by: `@obsy/storage-s3`, as an npm dependency (`aws4fetch` 1.0.20). Its source is not copied into this repository. Bundles that include `@obsy/storage-s3`, such as the Obsidian plugin and the platform probe (`obsy-probe`), ship it and must keep this notice.
- Source: <https://github.com/mhart/aws4fetch>
- Licence: MIT

```text
Copyright 2018 Michael Hart (michael.hart.au@gmail.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Algorithms written from public descriptions

These are reimplementations, not copied code. They are listed for completeness.

- **mulberry32** (seeded PRNG in `packages/storage-testkit/src/runtime.ts`, also bundled in the platform probe), by Tommy Ettinger, released into the public domain.
- **FNV-1a** (test etag hash in `packages/storage-testkit/src/memory-storage.ts`), by Glenn Fowler, Landon Curt Noll, and Kiem-Phong Vo, public domain.
