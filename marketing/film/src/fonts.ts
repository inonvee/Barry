import {continueRender, delayRender, cancelRender, staticFile} from 'remotion';
import {loadFont} from '@remotion/fonts';

// Fonts are vendored in public/fonts (SIL OFL) so renders never depend on the network.
// Variable files, restricted to the weight ranges we actually use.
const handle = delayRender('Loading Barry fonts');

Promise.all([
  loadFont({family: 'Inter', url: staticFile('fonts/inter-latin.woff2'), weight: '300 700'}),
  loadFont({family: 'HeeboHe', url: staticFile('fonts/heebo-hebrew.woff2'), weight: '300 800'}),
  loadFont({family: 'JetBrains Mono', url: staticFile('fonts/jetbrainsmono-latin.woff2'), weight: '400 500'}),
])
  .then(() => document.fonts.ready)
  .then(() => continueRender(handle))
  .catch((e) => cancelRender(e));
