# Third-party notices

## @kapso/whatsapp-cloud-api

- Project: `gokapso/whatsapp-cloud-api-js`
- URL: https://github.com/gokapso/whatsapp-cloud-api-js
- Commit: `effe133c324296bbfd8251655ece08bc21748154`
- Declared license: MIT (`package.json` and `README.md`; this HEAD does not contain a standalone `LICENSE` file)
- Upstream source: `src/webhooks/verify.ts`
- Destination: `src/domain/meta-webhook-signature.ts`
- Adaptation: retained the Node.js HMAC-SHA256 plus timing-safe comparison pattern; changed the API to accept only raw bytes, added strict header parsing, body/secret limits and fail-closed validation, and removed framework assumptions.

MIT License

Copyright (c) Kapso

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
