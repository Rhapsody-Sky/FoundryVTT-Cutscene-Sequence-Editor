import { defaultButtonProperties } from '../../domain/button.js';
import type { SimpleBarsValues, SimpleTextValues, SimpleVideoValues, SimpleAudioValues, SimpleVideoKeying, SimpleImageValues, SimpleButtonValues } from '../simple-composition.js';

export const DEFAULT_BARS: SimpleBarsValues = {
  startMs: 0, entranceMs: 800, durationMode: 'sequence-end', durationMs: 5_000, heightFraction: 0.12,
  appearance: { blendMode: 'normal', opacity: 1 }
};
export const DEFAULT_TEXT: SimpleTextValues = {
  startMs: 0, entranceMs: 800, durationMode: 'fixed', durationMs: 5_000, exitMs: 800,
  text: 'Title', fontFamily: 'Signika', fontSize: 96, minimumFontSize: 36,
  color: '#ffffff', align: 'center', box: { x: 192, y: 378, width: 1536, height: 324 }, shrinkToFit: true,
  appearance: { blendMode: 'normal', opacity: 1 },
  outline: { enabled: false, color: '#ffffff', opacity: 1, width: 2 },
  shadow: { enabled: false, color: '#000000', opacity: 0.75, offsetX: 0, offsetY: 8, blur: 16 },
  glow: { enabled: false, color: '#ffffff', opacity: 0.75, radius: 24 }
};
export const DEFAULT_VIDEO: SimpleVideoValues = {
  startMs: 0, entranceMs: 0, exitMs: 0, sourcePath: '', fit: 'contain', volume: 1, muted: false,
  appearance: { blendMode: 'normal', opacity: 1 }
};
export const DEFAULT_AUDIO_CLIP_DURATION_MS = 5_000;
export const DEFAULT_AUDIO: SimpleAudioValues = {
  startMs: 0, entranceMs: 0, exitMs: 0, sourcePath: '', clipDurationMs: DEFAULT_AUDIO_CLIP_DURATION_MS, volume: 1, muted: false, loop: false, loopIndefinitely: false
};
export const MAX_AUDIO_DURATION_MS = 604_800_000;
export const DEFAULT_VIDEO_KEYING: SimpleVideoKeying = { enabled: false, color: '#00ff00', tolerance: 0.1, softness: 0.05 };

export const DEFAULT_IMAGE: SimpleImageValues = {
  startMs: 0, entranceMs: 800, durationMode: 'fixed', durationMs: 5_000, exitMs: 800,
  sourcePath: '', fit: 'cover', box: { x: 0, y: 0, width: 1920, height: 1080 },
  crop: { x: 0, y: 0, width: 1, height: 1 },
  mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  appearance: { blendMode: 'normal', opacity: 1 },
  outline: { enabled: false, color: '#ffffff', opacity: 1, width: 2 },
  shadow: { enabled: false, color: '#000000', opacity: 0.75, offsetX: 0, offsetY: 8, blur: 16 },
  glow: { enabled: false, color: '#ffffff', opacity: 0.75, radius: 24 }
};
export const DEFAULT_BUTTON_PROPERTIES = defaultButtonProperties();
export const DEFAULT_BUTTON: SimpleButtonValues = {
  startMs: 0, entranceMs: 800, exitMs: 800, durationMode: 'fixed', durationMs: 5_000,
  action: { kind: 'continue' }, label: DEFAULT_BUTTON_PROPERTIES.label,
  fontFamily: DEFAULT_BUTTON_PROPERTIES.fontFamily, fontSize: DEFAULT_BUTTON_PROPERTIES.fontSize,
  color: DEFAULT_BUTTON_PROPERTIES.color, backgroundColor: DEFAULT_BUTTON_PROPERTIES.backgroundColor,
  box: DEFAULT_BUTTON_PROPERTIES.box, shape: DEFAULT_BUTTON_PROPERTIES.shape,
  outline: { enabled: false, color: '#ffffff', opacity: 1, width: 2 },
  shadow: { enabled: false, color: '#000000', opacity: 0.75, offsetX: 0, offsetY: 8, blur: 16 },
  glow: { enabled: false, color: '#ffffff', opacity: 0.75, radius: 24 }
};
