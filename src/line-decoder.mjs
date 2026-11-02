/**
 * 行式 UTF-8 解码器。
 *
 * Node 的 stream 回调给的是 Buffer；直接对每个 chunk 调 `toString('utf8')`
 * 会在 chunk 边界把一个多字节字符（中文/emoji）截成 U+FFFD，JSON 仍然合法，
 * 但内容被静默改写。StringDecoder 会跨 chunk 保留未完成的多字节序列。
 *
 * 同时负责按 `\n` 切行；行内保留 `\r`，由调用方按需 trim。
 */
import { StringDecoder } from 'node:string_decoder';

export class LineDecoder {
  #decoder = new StringDecoder('utf8');
  #buf = '';

  /** 喂一个 Buffer；返回本轮切出的完整行（不含换行符）。 */
  push(chunk) {
    this.#buf += this.#decoder.write(chunk);
    return this.#drain(false);
  }

  /** EOF：把 decoder 里残留的半个字符和最后一行一起吐出来。 */
  end() {
    this.#buf += this.#decoder.end();
    return this.#drain(true);
  }

  #drain(flush) {
    const lines = [];
    let i;
    while ((i = this.#buf.indexOf('\n')) !== -1) {
      lines.push(this.#buf.slice(0, i));
      this.#buf = this.#buf.slice(i + 1);
    }
    if (flush && this.#buf) {
      lines.push(this.#buf);
      this.#buf = '';
    }
    return lines;
  }
}
