# Third-party notices

## RoverDevKit wheel-soil model

`src/lib/mobility.ts` adapts the rigid-wheel stress equations and grouser heuristic from RoverDevKit, commit `ec0b198f01bca4c8ce2892577e72e9c9c65914b5`: https://github.com/Complex-Systems-Design-Lab/roverdevkit . The source was reviewed and pinned in the research pipeline. LUNORIZON adds its own integration, limits, UI and bisection solver; no upstream hardware validation transfers automatically.

MIT License

Copyright (c) 2026 Coordinated Autonomous Systems Lab, Duke University

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

## Fonts

The interface uses Manrope and IBM Plex Mono, bundled through Fontsource (`@fontsource/manrope` 5.3.0, `@fontsource/ibm-plex-mono` 5.3.0). Both are licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org).

- Manrope: Copyright 2019 The Manrope Project Authors (https://github.com/sharanda/manrope)
- IBM Plex Mono: Copyright 2017 IBM Corp. All rights reserved.
