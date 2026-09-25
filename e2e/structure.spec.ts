import { expect, test, type Page } from '@playwright/test';

/**
 * WAV 结构验收：固定字节样本覆盖
 * 区域外格式块、越界音频块、半帧尾部与合法扩展块，
 * 核对导入状态、错误类别、帧数与候选规则比对入口。
 * 损坏样本必须在结构检查阶段稳定判定 CORRUPT，
 * 不进入浏览器解码、不生成任何扫描结果；
 * 合法扩展块样本正常导入，既有规则结论与比对入口不变。
 * 素材均为本地生成的字节序列，文件不离开本机。
 */

const SAMPLE_RATE = 8000;
const FRAME_COUNT = 100;

/** 合法 16bit 单声道 WAV；tailBytes 在 data 尾部追加不足一帧的残缺字节 */
function buildMonoWav(
  clips: Array<{ start: number; end: number }>,
  tailBytes = 0
): Buffer {
  const dataBytes = FRAME_COUNT * 2 + tailBytes;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (const { start, end } of clips) {
    for (let f = start; f <= end; f++) buf.writeInt16LE(32767, 44 + f * 2);
  }
  return buf;
}

/** 区域外格式块：声明区域完整合法，文件尾在区域外附带可解析的 fmt 区块 */
function wavWithTrailingFmtChunk(): Buffer {
  const base = buildMonoWav([{ start: 40, end: 44 }]);
  const trailing = Buffer.alloc(24);
  trailing.write('fmt ', 0, 'ascii');
  trailing.writeUInt32LE(16, 4);
  trailing.writeUInt16LE(1, 8);
  trailing.writeUInt16LE(1, 10);
  trailing.writeUInt32LE(SAMPLE_RATE, 12);
  trailing.writeUInt32LE(SAMPLE_RATE * 2, 16);
  trailing.writeUInt16LE(2, 20);
  trailing.writeUInt16LE(16, 22);
  // RIFF 声明尺寸不同步扩大：fmt 区块整体落在声明区域之外
  return Buffer.concat([base, trailing]);
}

/** 越界音频块：data 区块物理上完整，但越过声明的 RIFF 末端 */
function wavWithDataChunkCrossingRiffEnd(): Buffer {
  const buf = buildMonoWav([{ start: 40, end: 44 }]);
  // 声明的 RIFF 区域在 data 区块体中途（第 144 字节）结束，
  // data 区块体为 44..244，音频数据完整落在物理文件内
  buf.writeUInt32LE(36 + FRAME_COUNT, 4);
  return buf;
}

/** 半帧尾部：data 尾部多 1 字节，不足一个完整采样帧（各尺寸声明一致） */
function wavWithHalfFrameTail(): Buffer {
  return buildMonoWav([{ start: 40, end: 44 }], 1);
}

/** 合法扩展块：fmt 与 data 之间插入 LIST 区块，RIFF 声明尺寸同步 */
function wavWithListChunk(): Buffer {
  const base = buildMonoWav([{ start: 40, end: 44 }]);
  const listChunk = Buffer.alloc(8 + 26);
  listChunk.write('LIST', 0, 'ascii');
  listChunk.writeUInt32LE(26, 4);
  listChunk.write('INFOISFT', 8, 'ascii');
  const combined = Buffer.concat([
    base.subarray(0, 36),
    listChunk,
    base.subarray(36)
  ]);
  combined.writeUInt32LE(36 + listChunk.length + FRAME_COUNT * 2, 4);
  return combined;
}

async function loadFile(page: Page, buffer: Buffer, name: string): Promise<void> {
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('file-input').click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles({ name, mimeType: 'audio/wav', buffer });
}

/** 损坏样本公共断言：稳定判定 CORRUPT，不生成结果，无比对入口 */
async function expectCorrupt(page: Page): Promise<void> {
  await expect(page.getByTestId('error-panel')).toBeVisible();
  await expect(page.getByTestId('error-title')).toContainText('CORRUPT');
  await expect(page.getByTestId('error-title')).toContainText('损坏');
  await expect(page.getByTestId('summary-panel')).toHaveCount(0);
  await expect(page.getByTestId('verdict')).toHaveCount(0);
  await expect(page.getByTestId('compare-panel')).toHaveCount(0);
}

test('区域外格式块：稳定判定 CORRUPT，不生成扫描结果', async ({ page }) => {
  await page.goto('/');
  await loadFile(page, wavWithTrailingFmtChunk(), 'trailing-fmt.wav');
  await expectCorrupt(page);
  await expect(page.getByTestId('error-detail')).toContainText('区域外');
});

test('越界音频块：data 越过声明的 RIFF 末端，稳定判定 CORRUPT', async ({ page }) => {
  await page.goto('/');
  await loadFile(page, wavWithDataChunkCrossingRiffEnd(), 'crossing-data.wav');
  await expectCorrupt(page);
  await expect(page.getByTestId('error-detail')).toContainText('区域外');
});

test('半帧尾部：残缺尾样本稳定判定 CORRUPT，不按截短帧数出结果', async ({ page }) => {
  await page.goto('/');
  await loadFile(page, wavWithHalfFrameTail(), 'half-frame.wav');
  await expectCorrupt(page);
  await expect(page.getByTestId('error-detail')).toContainText('完整采样帧');
});

test('合法扩展块：正常导入，帧数正确，候选规则比对入口可用', async ({ page }) => {
  await page.goto('/');
  await loadFile(page, wavWithListChunk(), 'with-list-chunk.wav');

  // 导入成功：结论与既有规则结果一致（帧 40..44 满幅削波 → 需重采 1 段）
  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  await expect(page.getByTestId('total-clip-ms')).toHaveText('1 ms');
  await expect(page.getByTestId('channel-stat')).toContainText('1 段');

  // 帧数：100 帧 @8000Hz → 总时长 0.013 s；削波段帧范围 40–44
  await expect(page.getByTestId('summary-panel')).toContainText('0.013 s');
  const rows = page.getByTestId('segment-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('40–44');

  // 比对入口：应用候选规则（默认与基线一致）→ 两套结论并列、无差异
  await page.getByTestId('apply-rule').click();
  await expect(page.getByTestId('compare-summary')).toBeVisible();
  await expect(page.getByTestId('baseline-verdict')).toHaveText('需重采');
  await expect(page.getByTestId('candidate-verdict')).toHaveText('需重采');
  await expect(page.getByTestId('baseline-count')).toHaveText('1 段');
  await expect(page.getByTestId('candidate-count')).toHaveText('1 段');
  await expect(page.getByTestId('no-diff')).toBeVisible();
});
