import { describe, expect, it } from 'vitest';
import { parseWavHeader } from '../../src/audio/wav-parser';
import { WavError, type WavErrorCode } from '../../src/audio/types';
import { buildWavBytes } from '../fixtures/wav';

function expectCode(fn: () => unknown, code: WavErrorCode): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WavError);
    expect((e as WavError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 WavError(${code})，但未抛错`);
}

describe('WAV 头解析', () => {
  it('合法 PCM WAV 解析成功', () => {
    const info = parseWavHeader(buildWavBytes({}));
    expect(info).toMatchObject({
      channels: 1,
      sampleRate: 8000,
      bitsPerSample: 16,
      frameCount: 4
    });
  });

  it('双声道 24bit 合法文件解析成功', () => {
    const info = parseWavHeader(
      buildWavBytes({ channels: 2, sampleRate: 44100, bitsPerSample: 24, frameCount: 10 })
    );
    expect(info.frameCount).toBe(10);
    expect(info.channels).toBe(2);
  });

  it('8bit/32bit 位深解析成功', () => {
    expect(parseWavHeader(buildWavBytes({ bitsPerSample: 8 })).bitsPerSample).toBe(8);
    expect(parseWavHeader(buildWavBytes({ bitsPerSample: 32 })).bitsPerSample).toBe(32);
  });

  it('奇数尺寸 LIST 区块的填充字节被正确跳过', () => {
    const info = parseWavHeader(
      buildWavBytes({
        extraChunks: [{ id: 'LIST', size: 5, odd: true }],
        frameCount: 2
      })
    );
    expect(info.frameCount).toBe(2);
  });

  it('IEEE float(formatTag=3) 与 extensible(0xfffe) 头解析成功', () => {
    expect(parseWavHeader(buildWavBytes({ formatTag: 3 })).formatTag).toBe(3);
    expect(parseWavHeader(buildWavBytes({ formatTag: 0xfffe })).formatTag).toBe(
      0xfffe
    );
  });

  it('ADPCM 等其它编码（如 formatTag=2）头结构仍可解析，交给解码器定夺', () => {
    // 非 PCM/float/extensible 时不校验 byteRate，结构合法即放行
    const info = parseWavHeader(
      buildWavBytes({ formatTag: 2, byteRateOverride: 999 })
    );
    expect(info.formatTag).toBe(2);
  });

  it('不是 RIFF/WAVE → NOT_WAV', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ riffTag: 'RIFX' })), 'NOT_WAV');
    expectCode(() => parseWavHeader(buildWavBytes({ waveTag: 'AVI ' })), 'NOT_WAV');
  });

  it('字节过小 → NOT_WAV', () => {
    expectCode(() => parseWavHeader(new ArrayBuffer(4)), 'NOT_WAV');
  });

  it('RIFF 声明尺寸超出实际字节 → CORRUPT（截断）', () => {
    const buf = buildWavBytes({ frameCount: 100, truncate: 60 });
    expectCode(() => parseWavHeader(buf), 'CORRUPT');
  });

  it('区块超出文件末尾 → CORRUPT', () => {
    // 手工构造：data 声明 999 字节但文件立刻结束（RIFF 尺寸声明一致，绕过前置校验）
    const buf = new ArrayBuffer(44);
    const v = new DataView(buf);
    const enc = (s: string, off: number) => {
      for (let i = 0; i < 4; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    enc('RIFF', 0);
    v.setUint32(4, 36, true);
    enc('WAVE', 8);
    enc('fmt ', 12);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true);
    v.setUint32(28, 16000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    enc('data', 36);
    v.setUint32(40, 999, true);
    expectCode(() => parseWavHeader(buf), 'CORRUPT');
  });

  it('RIFF 声明区域外附带可解析 fmt 区块 → CORRUPT', () => {
    // 声明区域本身完整合法，但文件尾在区域外附带一个貌似合法的 fmt 区块
    expectCode(
      () => parseWavHeader(buildWavBytes({ trailingChunks: [{ id: 'fmt ', size: 16 }] })),
      'CORRUPT'
    );
  });

  it('RIFF 声明区域外附带可解析 data 区块 → CORRUPT', () => {
    expectCode(
      () => parseWavHeader(buildWavBytes({ trailingChunks: [{ id: 'data', size: 8 }] })),
      'CORRUPT'
    );
  });

  it('声明区域在 fmt 之前结束、区域外才是 fmt/data → CORRUPT', () => {
    // riffSize=4：声明区域只有 "WAVE"，物理文件里的 fmt/data 全部落在区域外
    expectCode(() => parseWavHeader(buildWavBytes({ riffSize: 4 })), 'CORRUPT');
  });

  it('data 区块越过声明的 RIFF 末端（物理文件完整）→ CORRUPT', () => {
    // riffSize=40：声明区域末端（48 字节处）切过 data 区块体（44..52），
    // 音频数据物理上完整落在文件内，但越过声明的 RIFF 末端
    expectCode(() => parseWavHeader(buildWavBytes({ riffSize: 40 })), 'CORRUPT');
  });

  it('data 尾部不足一个完整采样帧 → CORRUPT（不得向下取整）', () => {
    // 16bit 单声道：4 帧 + 1 字节残缺尾样本
    expectCode(() => parseWavHeader(buildWavBytes({ dataTailBytes: 1 })), 'CORRUPT');
    // 16bit 双声道：4 帧 + 2 字节（半帧）
    expectCode(
      () => parseWavHeader(buildWavBytes({ channels: 2, dataTailBytes: 2 })),
      'CORRUPT'
    );
  });

  it('合法扩展区块（fact/LIST）在声明区域内：帧数解析不受影响', () => {
    const info = parseWavHeader(
      buildWavBytes({
        frameCount: 6,
        extraChunks: [
          { id: 'fact', size: 4 },
          { id: 'LIST', size: 5, odd: true }
        ]
      })
    );
    expect(info.frameCount).toBe(6);
    expect(info.dataBytes).toBe(12);
  });

  it('非法位深 → CORRUPT', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ bitsOverride: 12 })), 'CORRUPT');
  });

  it('非法声道数 → CORRUPT', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ channelsOverride: 0 })), 'CORRUPT');
    expectCode(() => parseWavHeader(buildWavBytes({ channelsOverride: 65 })), 'CORRUPT');
  });

  it('非法采样率 → CORRUPT', () => {
    expectCode(
      () => parseWavHeader(buildWavBytes({ sampleRateOverride: 0 })),
      'CORRUPT'
    );
    expectCode(
      () => parseWavHeader(buildWavBytes({ sampleRateOverride: 1_000_000 })),
      'CORRUPT'
    );
  });

  it('块对齐与声道/位深不一致 → CORRUPT', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ blockAlignOverride: 7 })), 'CORRUPT');
  });

  it('PCM/IEEE-float 字节率不一致 → CORRUPT', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ byteRateOverride: 123 })), 'CORRUPT');
    expectCode(
      () => parseWavHeader(buildWavBytes({ formatTag: 3, byteRateOverride: 1 })),
      'CORRUPT'
    );
  });

  it('缺 fmt 区块 → CORRUPT', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ fmtTag: 'xxxx' })), 'CORRUPT');
  });

  it('缺 data 区块 → NO_TRACK', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ includeData: false })), 'NO_TRACK');
  });

  it('0 帧数据 → NO_TRACK', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ dataBytesOverride: 0 })), 'NO_TRACK');
  });

  it('WavError 携带错误码', () => {
    try {
      parseWavHeader(new ArrayBuffer(2));
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(WavError);
      expect((e as WavError).code).toBe('NOT_WAV');
    }
  });
});
