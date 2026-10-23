import { VideoKeyingFilter, VideoKeyingPool, keyAlpha, keyRGB } from '../../src/rendering/video-keying.js';
import type { VideoKeying } from '../../src/domain/sequence.js';

const button = document.getElementById('run') as HTMLButtonElement;
const output = document.getElementById('result') as HTMLPreElement;
const samples = document.getElementById('samples') as HTMLDivElement;
button.addEventListener('click', () => {
  const checks: { name: string; pixels?: number[]; passed: true }[] = [];
  let pool: VideoKeyingPool | null = null;
  const filters: VideoKeyingFilter[] = [];
  try {
    const source = document.createElement('canvas'); source.width = source.height = 2;
    const input = new Uint8ClampedArray([0, 255, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 128, 255, 0, 128]);
    source.getContext('2d')!.putImageData(new ImageData(input, 2, 2), 0, 0);
    // Test-only decoder metadata on a genuine canvas accepted by texImage2D.
    Object.assign(source, { videoWidth: 2, videoHeight: 2, readyState: 4, seeking: false });
    const video = source as unknown as HTMLVideoElement;
    const green: VideoKeying = { enabled: true, color: '#00ff00', tolerance: 0.1, softness: 0.4 };
    const blue: VideoKeying = { enabled: true, color: '#0000ff', tolerance: 0, softness: 0 };
    const close = (actual: number, expected: number, label: string, tolerance = 3) => {
      if (Math.abs(actual - expected) > tolerance) throw new Error(`${label}: ${actual}; expected ${expected}`);
    };
    // Inspection copies are test-only. Production direct outputs never copy.
    const read = (filter: VideoKeyingFilter) => {
      const inspection = document.createElement('canvas'); inspection.width = inspection.height = 2;
      const context = inspection.getContext('2d')!; context.drawImage(filter.canvas, 0, 0);
      return [...context.getImageData(0, 0, 2, 2).data];
    };
    pool = new VideoKeyingPool();
    const first = new VideoKeyingFilter(pool); filters.push(first); first.draw(video, green);
    const firstPixels = read(first);
    for (let index = 0; index < 4; index += 1) {
      const rgb = [input[index * 4]! / 255, input[index * 4 + 1]! / 255, input[index * 4 + 2]! / 255] as const;
      const alpha = keyAlpha(rgb, keyRGB(green.color), green.tolerance, green.softness) * input[index * 4 + 3]! / 255;
      close(firstPixels[index * 4 + 3]!, alpha * 255, `green alpha at row-major pixel ${index}`);
      for (let channel = 0; channel < 3; channel += 1) close(firstPixels[index * 4 + channel]!, alpha === 0 ? 0 : input[index * 4 + channel]!, `unpremultiplied RGB at row-major pixel ${index}/${channel}`);
    }
    checks.push({ name: 'Production direct GPU alpha, soft edge, unpremultiplication and top/bottom orientation', passed: true, pixels: firstPixels });
    const second = new VideoKeyingFilter(pool); filters.push(second); second.draw(video, blue);
    const secondPixels = read(second);
    for (let channel = 0; channel < 4; channel += 1) {
      close(secondPixels[channel]!, input[channel]!, 'Blue key preserves top green');
      close(secondPixels[8 + channel]!, 0, 'Blue key clears bottom blue');
    }
    checks.push({ name: 'Independent blue-key frame on a second direct GPU output', passed: true, pixels: secondPixels });
    if (JSON.stringify(read(first)) !== JSON.stringify(firstPixels)) throw new Error('Second draw overwrote the first direct frame');
    checks.push({ name: 'First direct soft-key frame survives a second clip draw', passed: true });
    for (let index = 0; index < 18; index += 1) {
      const filter = new VideoKeyingFilter(pool); filters.push(filter); filter.draw(video, index % 2 ? green : blue);
    }
    if (JSON.stringify(read(first)) !== JSON.stringify(firstPixels) || JSON.stringify(read(second)) !== JSON.stringify(secondPixels)) throw new Error('Twenty private outputs do not retain independent pixels');
    checks.push({ name: 'Twenty overlapping outputs retain independent frames with four direct targets and overflow caches', passed: true });
    samples.replaceChildren(source, first.canvas, second.canvas);
    // Keep separate, deterministic previews after resources are released below.
    for (const canvas of [first.canvas, second.canvas]) {
      const copy = document.createElement('canvas'); copy.width = copy.height = 2; copy.getContext('2d')!.drawImage(canvas, 0, 0); canvas.replaceWith(copy);
    }
    output.textContent = JSON.stringify({ passed: true, checks }, null, 2);
  } catch (error) { output.textContent = JSON.stringify({ passed: false, checks, error: String(error) }, null, 2); }
  finally { for (const filter of filters) filter.dispose(); pool?.dispose(); }
});
