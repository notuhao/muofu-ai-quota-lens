# Third-party notices and provenance

Muofu AI Quota Lens is an independent project. The project code and original visual assets are distributed under the repository's [MIT License](LICENSE), except where this notice states otherwise.

## Codex Meter

Credits analytics behavior and private-endpoint compatibility were informed by:

- Project: [`Wangnov/codex-meter`](https://github.com/Wangnov/codex-meter)
- Reviewed tree: [`a4c8873ad35bcb4769d9fee4675671eed0aec333`](https://github.com/Wangnov/codex-meter/tree/a4c8873ad35bcb4769d9fee4675671eed0aec333)
- License: MIT
- Copyright: Copyright (c) 2026 Jun Zhao

Since version 0.2.0, this extension no longer uses the upstream active-token request pattern. It independently implements passive observation of requests already made by the ChatGPT page, while preserving the upstream notice because substantial earlier design and compatibility work informed this project.

The upstream MIT license text follows:

> MIT License
>
> Copyright (c) 2026 Jun Zhao
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## ChatGPT Route Inspector

[`Liu-Bot24/chatgpt-route-inspector`](https://github.com/Liu-Bot24/chatgpt-route-inspector) was reviewed only to understand publicly observable browser behavior and response field names. At reviewed tree [`4f98a663c4fb111f582f6a4d1aaefd190a5d9b7a`](https://github.com/Liu-Bot24/chatgpt-route-inspector/tree/4f98a663c4fb111f582f6a4d1aaefd190a5d9b7a), no root license file or package license declaration was found.

Consequently, this project does not copy, translate, bundle, or derive source code from that repository. The route feature is an independent implementation based on browser APIs and model metadata visible in ChatGPT requests and responses.

## Project visual assets

The PNG files under `icons/` were created specifically for Muofu AI Quota Lens. They do not contain or reproduce OpenAI, ChatGPT, Codex, Mozilla, or Firefox logos. The project distributes these original icons under the repository's MIT License.

No remote font, image, script, analytics asset, or third-party runtime package is bundled with the extension.

## Interface facts and services

Names of private paths and response fields document observed compatibility facts; they are not copied OpenAI source code and do not imply that OpenAI authorizes, endorses, or promises continued access to those interfaces. Users remain responsible for the terms applicable to their use. See [SECURITY.md](SECURITY.md#服务条款与私有接口风险).

## Trademarks

ChatGPT, Codex, and OpenAI are trademarks of OpenAI. Firefox and Mozilla are trademarks of Mozilla. Their names are used only to describe compatibility and are not evidence of affiliation, authorization, or endorsement. Muofu AI Quota Lens does not bundle official brand logos from those organizations.
