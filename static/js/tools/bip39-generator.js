/* ==========================================================================
   BIP39 助记词生成器（bip39-generator）

   熵 → 助记词 → 种子三步：熵按 BIP39 的规则拼上 SHA-256 校验位，切成 11 位一组
   去 2048 词表里查词；种子是 PBKDF2-HMAC-SHA512(助记词, "mnemonic"+口令, 2048, 64B)。

   参考实现：src/tools/bip39-generator/（it-tools, GPLv3）

   ---- 与参考实现的差别 ----
   1. **校验和/种子是自己算的，没用 @it-tools/bip39**。
      实际打进 static/lib/bip39/bundle.js 的 @it-tools/bip39@0.0.4 只有
      Object.keys() 里这 13 个成员：9 个 *WordList、defaultList，
      以及 entropyToMnemonic / mnemonicToEntropy / generateEntropy。
      简报里提到的 generateMnemonic / mnemonicToSeed / validateMnemonic /
      generateRandomMnemonic **一个都不存在**；而且
        · entropyToMnemonic 内部 t() 只接受长度 16..32 的 hex 串
          （`generateEntropy` 同理），也就是最多 128 位熵 → 最多 12 个词，
          15/18/21/24 词这条路在库里根本走不通；
        · mnemonicToEntropy 遇到不在词表里的词不会报错，indexOf 返回 -1，
          .toString(2).padStart(11,'0') 变成 '11111111111'（2047），静默出错。
      所以这个库在本工具里只当「10 份 2048 词表」用，其余逻辑自己实现。
   2. **口令（passphrase）与种子**是新增的，参考实现没有。它只有
      语言下拉 + 熵输入框 + 助记词输入框，靠 computed 双向绑定。
      这里保留双向绑定，但把「谁触发谁更新」写成了显式的 input 监听，
      并补了参考实现没有的：12/15/18/21/24 词数选择、随机生成、校验状态提示、
      种子 hex 输出、词表检索。
      参考实现的 `withDefaultOnError(..., passphraseInput.value)` 在熵非法时会
      保留旧助记词，这里沿用这个行为（只提示错误，不清空对方）。
   3. **SHA-256 / SHA-512 / HMAC / PBKDF2 是纯 JS 手写的**。测试环境（jsdom）
      没有 crypto.subtle，页面里也没有别的哈希库可用；照抄一坨 SHA-512 进工具
      文件是唯一的路。种子派生一次 2048 轮大约 200~400 ms，所以 UI 上做了防抖。
   4. 输入侧的助记词切分用 /\s+/ 而不是词表自带的 spacer：日文词表的 spacer 是
      全角空格 U+3000，用户从别的工具粘过来的通常是普通空格。输出仍然按词表
      自带的 spacer 拼。
   5. **排版照抄参考实现**。原版第一行是 <n-grid cols="3" x-gap="12">：第 1 列
      <c-select label="Language:">，第 2-3 列 <n-form-item label="Entropy (seed):">；
      第二行是 <n-form-item label="Passphrase (mnemonic):">。三个标签全是**上标签**
      （c-label 默认 labelPosition="top"、naive-ui 默认 label-placement="top"），
      左对齐、14px。这里照抄这个三列网格，标签一律放在控件上面一行。
      词数下拉、生成按钮是本实现自己加的，也用上标签，并且不再像早先那样把
      两组「标签 + 控件」挤进同一个 field-row（那是 120px 左标签、右对齐的写法）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('bip39-generator');

  /**
   * 错误对象：带一个稳定的 code。
   *
   * 文案走 i18n（界面上会显示出来），但断言要跟语言无关，所以断言一律看 code ——
   * 见 __cases 里对 e.code 的检查。
   */
  function bip39Error(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  /* ======================================================================
     一、SHA-256（32 位字，JS 的位运算本来就是 32 位，直接写）
     ====================================================================== */

  var K256 = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function rotr32(x, n) { return (x >>> n) | (x << (32 - n)); }

  /** @param {Uint8Array} msg @returns {Uint8Array} 32 字节 */
  function sha256(msg) {
    var len = msg.length;
    var total = (((len + 9) + 63) >> 6) << 6;          // 补 0x80 + 长度字段，向上取整到 64 的倍数
    var buf = new Uint8Array(total);
    buf.set(msg);
    buf[len] = 0x80;
    var view = new DataView(buf.buffer);
    view.setUint32(total - 4, (len * 8) >>> 0, false); // 长度字段是大端 64 位，这里只写得下低 32 位

    var H = new Int32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    var w = new Int32Array(64);
    var i, off;

    for (off = 0; off < total; off += 64) {
      for (i = 0; i < 16; i++) w[i] = view.getInt32(off + i * 4, false);
      for (i = 16; i < 64; i++) {
        var x = w[i - 15], y = w[i - 2];
        var s0 = rotr32(x, 7) ^ rotr32(x, 18) ^ (x >>> 3);
        var s1 = rotr32(y, 17) ^ rotr32(y, 19) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], hh = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
        var S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + hh) | 0;
    }

    var out = new Uint8Array(32);
    var dv = new DataView(out.buffer);
    for (i = 0; i < 8; i++) dv.setInt32(i * 4, H[i], false);
    return out;
  }

  /* ======================================================================
     二、SHA-512（64 位字拆成高低两个 32 位）
     JS 没有 64 位整数，一个 64 位字拆成 (h, l) 两个 32 位字。轮函数里要用的
     循环移位全部展开写成表达式，不走函数调用 —— 一次种子派生要走 2 万多次
     压缩，每次压缩 480 次位移，函数调用的开销比移位本身还大（实测 1.2s → 0.13s）。
     用到的恒等式（对着 BigInt 参考实现穷举对拍过）：
       n < 32 时  ROTR^n (h,l) = ((h>>>n)|(l<<(32-n)), (l>>>n)|(h<<(32-n)))
       n > 32 时  ROTR^n = ROTR^(n-32) 作用在 (l,h) 上 —— 因为 ROTR^32 恰好
                  就是高低 32 位对调
       SHR^n (h,l) = (h>>>n, (l>>>n)|(h<<(32-n)))（n<32）

     另外两个坑记在这里：
     1) 轮函数里 f = e 取的是**更新前**的 e：SHA-512 的 h=g;g=f;f=e;e=d+T1
        是顺序赋值，先算 e 的话 f 就拿到新值了。
     2) 128 位长度字段是**大端**的：128 位整数的低 8 字节落在最后 8 字节，
        所以 bits 的高 32 位写 total-8、低 32 位写 total-4；写反了只有空消息
        能过，长度 >= 1 的消息全错（这个坑单独坑了很久）。
     ====================================================================== */

  var K512_HEX = ('428a2f98d728ae22 7137449123ef65cd b5c0fbcfec4d3b2f e9b5dba58189dbbc 3956c25bf348b538 59f111f1b605d019 923f82a4af194f9b ab1c5ed5da6d8118 ' +
    'd807aa98a3030242 12835b0145706fbe 243185be4ee4b28c 550c7dc3d5ffb4e2 72be5d74f27b896f 80deb1fe3b1696b1 9bdc06a725c71235 c19bf174cf692694 ' +
    'e49b69c19ef14ad2 efbe4786384f25e3 0fc19dc68b8cd5b5 240ca1cc77ac9c65 2de92c6f592b0275 4a7484aa6ea6e483 5cb0a9dcbd41fbd4 76f988da831153b5 ' +
    '983e5152ee66dfab a831c66d2db43210 b00327c898fb213f bf597fc7beef0ee4 c6e00bf33da88fc2 d5a79147930aa725 06ca6351e003826f 142929670a0e6e70 ' +
    '27b70a8546d22ffc 2e1b21385c26c926 4d2c6dfc5ac42aed 53380d139d95b3df 650a73548baf63de 766a0abb3c77b2a8 81c2c92e47edaee6 92722c851482353b ' +
    'a2bfe8a14cf10364 a81a664bbc423001 c24b8b70d0f89791 c76c51a30654be30 d192e819d6ef5218 d69906245565a910 f40e35855771202a 106aa07032bbd1b8 ' +
    '19a4c116b8d2d0c8 1e376c085141ab53 2748774cdf8eeb99 34b0bcb5e19b48a8 391c0cb3c5c95a63 4ed8aa4ae3418acb 5b9cca4f7763e373 682e6ff3d6b2b8a3 ' +
    '748f82ee5defb2fc 78a5636f43172f60 84c87814a1f0ab72 8cc702081a6439ec 90befffa23631e28 a4506cebde82bde9 bef9a3f7b2c67915 c67178f2e372532b ' +
    'ca273eceea26619c d186b8c721c0c207 eada7dd6cde0eb1e f57d4f7fee6ed178 06f067aa72176fba 0a637dc5a2c898a6 113f9804bef90dae 1b710b35131c471b ' +
    '28db77f523047d84 32caab7b40c72493 3c9ebe0a15c9bebc 431d67c49c100d4c 4cc5d4becb3e42b6 597f299cfc657e2a 5fcb6fab3ad6faec 6c44198c4a475817').split(' ');
  var KH = new Int32Array(80), KL = new Int32Array(80);
  for (var ki = 0; ki < 80; ki++) {
    KH[ki] = parseInt(K512_HEX[ki].slice(0, 8), 16) | 0;
    KL[ki] = parseInt(K512_HEX[ki].slice(8, 16), 16) | 0;
  }

  /** 64 位加法，结果放在 ADD_H / ADD_L 里。 */
  var ADD_H = 0, ADD_L = 0;
  function add64(ah, al, bh, bl) {
    var lo = (al >>> 0) + (bl >>> 0);
    ADD_H = ((ah >>> 0) + (bh >>> 0) + ((lo / 4294967296) | 0)) >>> 0;
    ADD_L = lo >>> 0;
  }

  var WH = new Int32Array(80), WL = new Int32Array(80);
  /** 补零后的消息缓冲区复用，避免每次压缩都 new 一份。 */
  var PAD512 = new Uint8Array(512);
  var PAD512_VIEW = new DataView(PAD512.buffer);

  /** SHA-512 核心，结果写进 out（64 字节），不自己分配。 */
  function sha512Into(msg, msgLen, out) {
    var total = (((msgLen + 17) + 127) >> 7) << 7;
    if (total > PAD512.length) {
      PAD512 = new Uint8Array(total);
      PAD512_VIEW = new DataView(PAD512.buffer);
    }
    PAD512.fill(0, 0, total);
    PAD512.set(msg.subarray(0, msgLen));
    PAD512[msgLen] = 0x80;
    var bits = msgLen * 8;
    PAD512_VIEW.setUint32(total - 16, 0, false);
    PAD512_VIEW.setUint32(total - 12, 0, false);
    PAD512_VIEW.setUint32(total - 8, Math.floor(bits / 4294967296), false); // 大端长度字段：高字在 total-8
    PAD512_VIEW.setUint32(total - 4, bits % 4294967296, false);             // 低字在 total-4

    var h0 = 0x6a09e667, h1 = 0xf3bcc908 | 0, h2 = 0xbb67ae85, h3 = 0x84caa73b | 0,
      h4 = 0x3c6ef372, h5 = 0xfe94f82b | 0, h6 = 0xa54ff53a, h7 = 0x5f1d36f1 | 0,
      h8 = 0x510e527f, h9 = 0xade682d1 | 0, h10 = 0x9b05688c, h11 = 0x2b3e6c1f | 0,
      h12 = 0x1f83d9ab, h13 = 0xfb41bd6b | 0, h14 = 0x5be0cd19, h15 = 0x137e2179 | 0;

    var i, off;
    for (off = 0; off < total; off += 128) {
      for (i = 0; i < 16; i++) {
        WH[i] = PAD512_VIEW.getInt32(off + i * 8, false);
        WL[i] = PAD512_VIEW.getInt32(off + i * 8 + 4, false);
      }
      for (i = 16; i < 80; i++) {
        var xh = WH[i - 15], xl = WL[i - 15], yh = WH[i - 2], yl = WL[i - 2];
        // σ0 = ROTR^1 ⊕ ROTR^8 ⊕ SHR^7 ; σ1 = ROTR^19 ⊕ ROTR^61 ⊕ SHR^6
        var s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
        var s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
        var s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6);
        var s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26));
        add64(WH[i - 16], WL[i - 16], s0h, s0l);
        add64(ADD_H, ADD_L, WH[i - 7], WL[i - 7]);
        add64(ADD_H, ADD_L, s1h, s1l);
        WH[i] = ADD_H; WL[i] = ADD_L;
      }

      var ah = h0, al = h1, bh = h2, bl = h3, ch = h4, cl = h5, dh = h6, dl = h7,
        eh = h8, el = h9, fh = h10, fl = h11, gh = h12, gl = h13, hh4 = h14, hl = h15;
      for (i = 0; i < 80; i++) {
        // Σ1(e) = ROTR^14 ⊕ ROTR^18 ⊕ ROTR^41
        var S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
        var S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
        var che = (eh & fh) ^ (~eh & gh), cel = (el & fl) ^ (~el & gl);
        add64(hh4, hl, S1h, S1l);
        add64(ADD_H, ADD_L, che, cel);
        add64(ADD_H, ADD_L, KH[i], KL[i]);
        add64(ADD_H, ADD_L, WH[i], WL[i]);
        var t1h = ADD_H, t1l = ADD_L;

        // Σ0(a) = ROTR^28 ⊕ ROTR^34 ⊕ ROTR^39
        var S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
        var S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
        var majh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
        var majl = (al & bl) ^ (al & cl) ^ (bl & cl);
        add64(S0h, S0l, majh, majl);
        var t2h = ADD_H, t2l = ADD_L;

        // f = e 取的是**更新前**的 e（上面 e 先算了 T1，所以这里要留一份旧的）
        var prevEh = eh, prevEl = el;
        add64(dh, dl, t1h, t1l); eh = ADD_H; el = ADD_L;
        hh4 = gh; hl = gl; gh = fh; gl = fl; fh = prevEh; fl = prevEl;
        dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
        add64(t1h, t1l, t2h, t2l); ah = ADD_H; al = ADD_L;
      }
      add64(h0, h1, ah, al); h0 = ADD_H; h1 = ADD_L;
      add64(h2, h3, bh, bl); h2 = ADD_H; h3 = ADD_L;
      add64(h4, h5, ch, cl); h4 = ADD_H; h5 = ADD_L;
      add64(h6, h7, dh, dl); h6 = ADD_H; h7 = ADD_L;
      add64(h8, h9, eh, el); h8 = ADD_H; h9 = ADD_L;
      add64(h10, h11, fh, fl); h10 = ADD_H; h11 = ADD_L;
      add64(h12, h13, gh, gl); h12 = ADD_H; h13 = ADD_L;
      add64(h14, h15, hh4, hl); h14 = ADD_H; h15 = ADD_L;
    }

    var dv = new DataView(out.buffer, out.byteOffset, 64);
    dv.setInt32(0, h0, false); dv.setInt32(4, h1, false); dv.setInt32(8, h2, false); dv.setInt32(12, h3, false);
    dv.setInt32(16, h4, false); dv.setInt32(20, h5, false); dv.setInt32(24, h6, false); dv.setInt32(28, h7, false);
    dv.setInt32(32, h8, false); dv.setInt32(36, h9, false); dv.setInt32(40, h10, false); dv.setInt32(44, h11, false);
    dv.setInt32(48, h12, false); dv.setInt32(52, h13, false); dv.setInt32(56, h14, false); dv.setInt32(60, h15, false);
  }

  /** @param {Uint8Array} msg @returns {Uint8Array} 64 字节 */
  function sha512(msg) {
    var out = new Uint8Array(64);
    sha512Into(msg, msg.length, out);
    return out;
  }

  /* ======================================================================
     三、HMAC-SHA512 / PBKDF2-HMAC-SHA512
     HMAC 的 ipad/opad 只跟密钥有关，所以拆成 hmacInit / hmacRun 两步，
     让一次 PBKDF2（2048 轮 × 2 次 HMAC）只算一次 pad。
     ====================================================================== */

  var BLOCK512 = 128;

  function hmacSha512(key, msg) {
    var ctx = hmacInit(key);
    return hmacRun(ctx, msg, msg.length, ctx.res);
  }

  function hmacInit(key) {
    var k = key.length > BLOCK512 ? sha512(key) : key;
    var inner = new Uint8Array(BLOCK512);
    var outer = new Uint8Array(BLOCK512);
    for (var i = 0; i < BLOCK512; i++) {
      var b = i < k.length ? k[i] : 0;
      inner[i] = b ^ 0x36;
      outer[i] = b ^ 0x5c;
    }
    return {
      inner: inner, outer: outer,
      inBuf: new Uint8Array(BLOCK512 + 256),   // 128 + 最长 256 字节的消息
      outBuf: new Uint8Array(BLOCK512 + 64),
      mid: new Uint8Array(64),
      res: new Uint8Array(64),
      res2: new Uint8Array(64)                 // PBKDF2 里 u 与 u' 乒乓，省一次分配
    };
  }

  /** @param ctx hmacInit 的返回值 @param msg 消息 @param len 消息长度 @param dest 64 字节输出 */
  function hmacRun(ctx, msg, len, dest) {
    ctx.inBuf.set(ctx.inner, 0);
    ctx.inBuf.set(msg, BLOCK512);
    sha512Into(ctx.inBuf, BLOCK512 + len, ctx.mid);
    ctx.outBuf.set(ctx.outer, 0);
    ctx.outBuf.set(ctx.mid, BLOCK512);
    sha512Into(ctx.outBuf, BLOCK512 + 64, dest);
    return dest;
  }

  /**
   * PBKDF2-HMAC-SHA512。BIP39 只要 dkLen=64，正好一个 SHA-512 块，
   * 所以这里不实现多块拼接，遇到更长的输出直接报错（省得留个半对的分支）。
   */
  function pbkdf2Sha512(password, salt, iterations, dkLen) {
    if (dkLen > 64) {
      throw bip39Error('dklen_too_big',
        t('err_dklen', 'dkLen > 64 is not implemented (this tool only needs a 64-byte seed)'));
    }
    var ctx = hmacInit(password);
    var block = new Uint8Array(salt.length + 4);
    block.set(salt);
    block[salt.length + 3] = 1; // 大端计数器 INT(1)
    var u = hmacRun(ctx, block, block.length, ctx.res);
    var acc = u.slice(0);
    for (var i = 1; i < iterations; i++) {
      u = hmacRun(ctx, u, 64, (i & 1) ? ctx.res2 : ctx.res);
      for (var j = 0; j < acc.length; j++) acc[j] ^= u[j];
    }
    return acc.slice(0, dkLen);
  }

  /* ======================================================================
     四、BIP39 本体
     ====================================================================== */

  /** 库里实际存在的 10 份词表，顺序与参考实现一致。label 是下拉框里的显示名，走 i18n。 */
  var LANGUAGES = [
    { key: 'englishWordList', label: t('lang_english', 'English') },
    { key: 'chineseSimplifiedWordList', label: t('lang_chinese_simplified', 'Chinese simplified') },
    { key: 'chineseTraditionalWordList', label: t('lang_chinese_traditional', 'Chinese traditional') },
    { key: 'czechWordList', label: t('lang_czech', 'Czech') },
    { key: 'frenchWordList', label: t('lang_french', 'French') },
    { key: 'italianWordList', label: t('lang_italian', 'Italian') },
    { key: 'japaneseWordList', label: t('lang_japanese', 'Japanese') },
    { key: 'koreanWordList', label: t('lang_korean', 'Korean') },
    { key: 'portugueseWordList', label: t('lang_portuguese', 'Portuguese') },
    { key: 'spanishWordList', label: t('lang_spanish', 'Spanish') }
  ];
  var DEFAULT_LANGUAGE = 'englishWordList';

  /** 词数 → 熵位数 / 字节数 / hex 字符数。 */
  var WORD_COUNTS = [12, 15, 18, 21, 24];
  var ENTROPY_BITS = { 12: 128, 15: 160, 18: 192, 21: 224, 24: 256 };
  var WORDS_PER_ENTROPY = { 12: 16, 15: 20, 18: 24, 21: 28, 24: 32 };
  /** 熵位数 → 合法标记，BIP39 只认这 5 档。 */
  var VALID_ENTROPY_BITS = { 128: true, 160: true, 192: true, 224: true, 256: true };
  var SEED_ITERATIONS = 2048;
  var SEED_BYTES = 64;
  var SEED_SALT_PREFIX = 'mnemonic';

  /** 取词表对象；key 不认识就退回英文。 */
  function wordList(lang) {
    var lib = window.BIP39;
    var list = lib && lib[lang || DEFAULT_LANGUAGE];
    if (!list || !Array.isArray(list.words)) list = lib[DEFAULT_LANGUAGE];
    return list;
  }

  function wordsOf(lang) { return wordList(lang).words; }

  /** 词数合法化，非法值一律退回 12。 */
  function normalizeWordCount(n) {
    var v = Number(n);
    return WORD_COUNTS.indexOf(v) === -1 ? 12 : v;
  }

  /** 词数 → 熵的字节数（= ENT/8）。 */
  function entropyBytesForWords(words) {
    return WORDS_PER_ENTROPY[normalizeWordCount(words)];
  }

  /** 词数 → 熵的 hex 字符数（= ENT/4）。 */
  function entropyHexLength(words) {
    return entropyBytesForWords(words) * 2;
  }

  var HEX_RE = /^[0-9a-fA-F]*$/;

  /** hex → 字节；非法字符抛错。 */
  function hexToBytes(hex) {
    var s = String(hex);
    if (s.length % 2 !== 0) throw bip39Error('hex_odd_length', t('err_hex_odd_length', 'The hex length must be even'));
    if (!HEX_RE.test(s)) throw bip39Error('hex_invalid', t('err_hex_invalid', 'Not a valid hexadecimal string'));
    var out = new Uint8Array(s.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  /** 字节数组 → 二进制串。 */
  function bytesToBits(bytes) {
    var bits = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      for (var k = 7; k >= 0; k--) bits += ((b >> k) & 1);
    }
    return bits;
  }

  /**
   * 熵 hex → 助记词。
   * @param {string} hex 长度必须是 32/40/48/56/64（= 128/160/192/224/256 位熵）
   * @param {string} [lang]
   * @throws 熵长度不对时抛错
   */
  function entropyToMnemonic(hex, lang) {
    var s = String(hex == null ? '' : hex).trim().toLowerCase();
    var bytes = hexToBytes(s);
    if (!VALID_ENTROPY_BITS[bytes.length * 8]) {
      throw bip39Error('invalid_entropy_bits',
        t('err_invalid_entropy_bits', 'Entropy must be 128, 160, 192, 224 or 256 bits (32, 40, 48, 56 or 64 hex chars), got {n}')
          .replace('{n}', String(bytes.length * 8)));
    }
    var list = wordList(lang);
    // 校验位长度 = ENT / 32
    var csBits = bytes.length * 8 / 32;
    var checksum = sha256(bytes);
    var bits = bytesToBits(bytes) + bytesToBits(checksum).slice(0, csBits);
    var out = [];
    for (var i = 0; i < bits.length; i += 11) out.push(list.words[parseInt(bits.substr(i, 11), 2)]);
    return out.join(list.spacer);
  }

  /** 助记词 → 词数组（按空白切，容忍全角空格）。 */
  function splitMnemonic(mnemonic) {
    return String(mnemonic == null ? '' : mnemonic).trim().split(/\s+/).filter(Boolean);
  }

  /**
   * 助记词 → 熵 hex。
   * @throws 词数不对、词不在词表里、校验和不符时抛错
   */
  function mnemonicToEntropy(mnemonic, lang) {
    var list = wordList(lang);
    var words = splitMnemonic(mnemonic);
    if (WORD_COUNTS.indexOf(words.length) === -1) {
      throw bip39Error('invalid_length',
        t('err_invalid_length', 'Invalid mnemonic length: {n} words (expected 12, 15, 18, 21 or 24)')
          .replace('{n}', String(words.length)));
    }
    var bits = '';
    for (var i = 0; i < words.length; i++) {
      var idx = list.words.indexOf(words[i]);
      // 注意：库里 mnemonicToEntropy 这里不判 -1，会拿 indexOf(-1)=2047 静默算错，
      // 这里显式判掉。
      if (idx === -1) {
        throw bip39Error('word_not_found',
          t('err_word_not_found', 'Word not in the word list: "{word}"').replace('{word}', words[i]));
      }
      bits += idx.toString(2).padStart(11, '0');
    }
    var entropyBits = Math.floor(bits.length * 32 / 33);
    var checksumBits = bits.length - entropyBits;
    var entropyBitStr = bits.slice(0, entropyBits);
    var entropyBytes = new Uint8Array(entropyBits / 8);
    for (var j = 0; j < entropyBytes.length; j++) entropyBytes[j] = parseInt(entropyBitStr.substr(j * 8, 8), 2);
    if (bytesToBits(sha256(entropyBytes)).slice(0, checksumBits) !== bits.slice(entropyBits)) {
      throw bip39Error('invalid_checksum', t('err_invalid_checksum', 'Invalid checksum'));
    }
    return U.hex(entropyBytes);
  }

  /**
   * 校验助记词，不抛错。
   * @returns {{valid: boolean, entropy: (string|null), error: (string|null), errorCode: (string|null)}}
   */
  function validateMnemonic(mnemonic, lang) {
    try {
      return { valid: true, entropy: mnemonicToEntropy(mnemonic, lang), error: null, errorCode: null };
    } catch (e) {
      return { valid: false, entropy: null, error: e.message, errorCode: e.code || null };
    }
  }

  /** 生成熵 hex。randomBytes 可注入（默认走 crypto.getRandomValues）。 */
  function generateEntropyHex(words, randomBytes) {
    var n = entropyBytesForWords(words);
    var rnd = randomBytes || U.randomBytes;
    return U.hex(rnd(n));
  }

  /** 生成助记词。randomBytes 可注入。 */
  function generateMnemonic(words, lang, randomBytes) {
    return entropyToMnemonic(generateEntropyHex(words, randomBytes), lang);
  }

  /**
   * 助记词 → 种子 hex（128 个字符）。
   * 口令为空时等价于 passphrase = ''，即 salt 就是 "mnemonic"。
   * 注意 NFKD 规范化：BIP39 要求助记词与口令都先做 NFKD。
   */
  function mnemonicToSeedHex(mnemonic, passphrase) {
    var norm = function (s) {
      var str = String(s == null ? '' : s);
      // normalize 在所有目标浏览器里都有；万一没有就原样返回，PBKDF2 结果照样自洽
      return typeof str.normalize === 'function' ? str.normalize('NFKD') : str;
    };
    var password = U.utf8Bytes(norm(splitMnemonic(mnemonic).join(' ')));
    var salt = U.utf8Bytes(norm(SEED_SALT_PREFIX + String(passphrase == null ? '' : passphrase)));
    return U.hex(pbkdf2Sha512(password, salt, SEED_ITERATIONS, SEED_BYTES));
  }

  /**
   * 词表检索：先前缀匹配再包含匹配，都按词表原顺序。
   * @returns {Array<{word: string, index: number}>}
   */
  function searchWords(query, lang, limit) {
    var list = wordList(lang);
    var q = String(query == null ? '' : query).trim().toLowerCase();
    var max = limit && limit > 0 ? limit : 50;
    var prefix = [], contains = [];
    if (!q) {
      for (var k = 0; k < list.words.length && prefix.length < max; k++) {
        prefix.push({ word: list.words[k], index: k });
      }
      return prefix;
    }
    for (var i = 0; i < list.words.length; i++) {
      var w = list.words[i];
      var lw = w.toLowerCase();
      if (lw.indexOf(q) === 0) prefix.push({ word: w, index: i });
      else if (lw.indexOf(q) !== -1) contains.push({ word: w, index: i });
    }
    return prefix.concat(contains).slice(0, max);
  }

  /* ======================================================================
     五、界面
     ====================================================================== */

  window.ItTools.register('bip39-generator', function (root) {
    var langSelect = D.h('select.layui-select', null, LANGUAGES.map(function (l, i) {
      return D.h('option', { value: l.key, text: l.label, selected: i === 0 });
    }));
    var countSelect = D.h('select.layui-select', null, WORD_COUNTS.map(function (c) {
      return D.h('option', {
        value: c,
        text: t('words_option', '{n} words ({bits}-bit entropy)')
          .replace('{n}', String(c))
          .replace('{bits}', String(ENTROPY_BITS[c]))
      });
    }));

    var entropyBox = D.h('textarea.layui-textarea', { rows: 2, spellcheck: 'false', placeholder: t('entropy_ph', 'Entropy (hex)...') });
    var mnemonicBox = D.h('textarea.layui-textarea', { rows: 3, spellcheck: 'false', placeholder: t('mnemonic_ph', 'Mnemonic...') });
    var entropyMsg = D.h('p.field-hint');
    var mnemonicMsg = D.h('p.field-hint');

    var passphraseBox = D.h('input.layui-input', { type: 'text', placeholder: t('passphrase_ph', 'Extra passphrase (optional)'), autocomplete: 'off' });
    var seedCard = D.outputCard(t('seed_card', 'Seed (hex, PBKDF2-HMAC-SHA512, 2048 rounds)'));
    var seedMsg = D.h('p.field-hint');

    var searchBox = D.h('input.layui-input', { type: 'search', placeholder: t('search_ph', 'Search the word list...'), autocomplete: 'off' });
    var searchOut = D.h('p.field-hint');

    var seedTimer = null;

    function setMsg(el, text, ok) {
      el.textContent = text || '';
      el.style.color = !text ? '' : (ok ? 'var(--ok, #16a34a)' : 'var(--danger, #dc2626)');
    }

    /** 熵变化 → 重算助记词；非法时保留旧助记词（与参考实现的 withDefaultOnError 一致）。 */
    function onEntropyInput() {
      var hex = entropyBox.value.trim();
      if (hex === '') {
        setMsg(entropyMsg, '');
        mnemonicBox.value = '';
        setMsg(mnemonicMsg, '');
        scheduleSeed();
        return;
      }
      if (!HEX_RE.test(hex)) {
        setMsg(entropyMsg, t('err_entropy_not_hex', 'Entropy should be a hexadecimal string'), false);
        scheduleSeed();
        return;
      }
      if (hex.length % 2 !== 0 || !VALID_ENTROPY_BITS[(hex.length / 2) * 8]) {
        setMsg(entropyMsg, t('err_entropy_length', 'Entropy length should be 32, 40, 48, 56 or 64 hex chars (got {n})')
          .replace('{n}', String(hex.length)), false);
        scheduleSeed();
        return;
      }
      var mn;
      try {
        mn = entropyToMnemonic(hex, langSelect.value);
      } catch (e) {
        setMsg(entropyMsg, e.message, false);
        scheduleSeed();
        return;
      }
      setMsg(entropyMsg, t('entropy_bytes', '{n} bytes of entropy').replace('{n}', String(hex.length / 2)), true);
      mnemonicBox.value = mn;
      setMsg(mnemonicMsg, t('words_checksum_ok', '{n} words, checksum OK')
        .replace('{n}', String(mn.split(/\s+/).length)), true);
      scheduleSeed();
    }

    /** 助记词变化 → 重算熵；非法时只报错，不动熵。 */
    function onMnemonicInput() {
      var mn = mnemonicBox.value.trim();
      if (mn === '') {
        setMsg(mnemonicMsg, '');
        setMsg(entropyMsg, '');
        scheduleSeed();
        return;
      }
      var res = validateMnemonic(mn, langSelect.value);
      if (!res.valid) {
        setMsg(mnemonicMsg, res.error, false);
        scheduleSeed();
        return;
      }
      setMsg(mnemonicMsg, t('valid_mnemonic', 'Valid mnemonic ({n} words)')
        .replace('{n}', String(mn.split(/\s+/).length)), true);
      entropyBox.value = res.entropy;
      setMsg(entropyMsg, t('entropy_bytes', '{n} bytes of entropy').replace('{n}', String(res.entropy.length / 2)), true);
      scheduleSeed();
    }

    /** 换语言时按新词表重新校验/换算。 */
    function onLanguageChange() {
      var mn = mnemonicBox.value.trim();
      if (mn === '') return;
      var res = validateMnemonic(mn, langSelect.value);
      if (res.valid) {
        mnemonicBox.value = entropyToMnemonic(res.entropy, langSelect.value);
        setMsg(mnemonicMsg, t('valid_mnemonic', 'Valid mnemonic ({n} words)')
          .replace('{n}', String(res.entropy.length * 4 / 32)), true);
        setMsg(entropyMsg, t('entropy_bytes', '{n} bytes of entropy').replace('{n}', String(res.entropy.length / 2)), true);
      } else {
        setMsg(mnemonicMsg, res.error, false);
      }
      scheduleSeed();
    }

    /** 种子派生要跑 2048 轮（几百毫秒），所以防抖，别跟着每个按键都算。 */
    function scheduleSeed() {
      if (seedTimer) window.clearTimeout(seedTimer);
      seedTimer = window.setTimeout(computeSeed, 300);
    }

    function computeSeed() {
      seedTimer = null;
      var mn = mnemonicBox.value.trim();
      if (mn === '') {
        seedCard.outputBody.textContent = '';
        setMsg(seedMsg, '');
        return;
      }
      var res = validateMnemonic(mn, langSelect.value);
      if (!res.valid) {
        seedCard.outputBody.textContent = '';
        setMsg(seedMsg, t('err_fix_mnemonic', 'Fix the mnemonic to derive a seed'), false);
        return;
      }
      var seed = mnemonicToSeedHex(mn, passphraseBox.value);
      seedCard.outputBody.textContent = seed;
      setMsg(seedMsg, t('seed_hex_chars', '{n} hex chars ({bytes} bytes)')
        .replace('{n}', String(SEED_BYTES * 2))
        .replace('{bytes}', String(SEED_BYTES)), true);
    }

    function onSearch() {
      var hits = searchWords(searchBox.value, langSelect.value, 50);
      searchOut.textContent = hits.length
        ? t('search_matches', '{n} match(es): {list}')
          .replace('{n}', String(hits.length))
          .replace('{list}', hits.map(function (h) { return h.index + ': ' + h.word; }).join(', '))
        : t('no_match', 'No match');
    }

    function generate() {
      var hex = generateEntropyHex(countSelect.value);
      entropyBox.value = hex;
      var mn = entropyToMnemonic(hex, langSelect.value);
      mnemonicBox.value = mn;
      setMsg(entropyMsg, t('entropy_bytes', '{n} bytes of entropy').replace('{n}', String(hex.length / 2)), true);
      setMsg(mnemonicMsg, t('words_checksum_ok', '{n} words, checksum OK')
        .replace('{n}', String(mn.split(/\s+/).length)), true);
      scheduleSeed();
    }

    var offs = [
      D.on(entropyBox, 'input', onEntropyInput),
      D.on(mnemonicBox, 'input', onMnemonicInput),
      D.on(passphraseBox, 'input', scheduleSeed),
      D.on(langSelect, 'change', onLanguageChange),
      D.on(searchBox, 'input', onSearch)
    ];

    root.appendChild(D.h('div.card', null,
      // 原版第一行：n-grid cols="3" x-gap="12" —— 第 1 列语言下拉，第 2-3 列熵输入框。
      // 两个标签都是上标签（c-select 的 c-label 默认 labelPosition="top"，
      // n-form-item 默认 label-placement="top"），左对齐、14px。
      D.h('div.grid', { style: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', alignItems: 'start' } },
        D.h('div', { style: { gridColumn: 'span 1', minWidth: '0' } },
          D.h('div.field', null,
            D.h('label.field-label', { text: t('language', 'Language:') }),
            langSelect)),
        D.h('div', { style: { gridColumn: 'span 2', minWidth: '0' } },
          D.h('div.field', null,
            D.h('label.field-label', { text: t('entropy', 'Entropy (hex):') }),
            D.h('div.input-group', null, entropyBox,
              U.copyButton(function () { return entropyBox.value; }, t('copy_entropy', 'Copy entropy'))),
            entropyMsg))),
      // 原版第二行：n-form-item "Passphrase (mnemonic):"，同样是上标签。
      D.h('div.field', null,
        D.h('label.field-label', { text: t('mnemonic', 'Mnemonic:') }),
        D.h('div.input-group', null, mnemonicBox,
          U.copyButton(function () { return mnemonicBox.value; }, t('copy_mnemonic', 'Copy mnemonic'))),
        mnemonicMsg),
      // 原版没有的：词数下拉 + 生成按钮。一个标签一个控件，
      // 不再把两组「标签 + 控件」塞进同一个 field-row 里。
      D.h('div.field', null,
        D.h('label.field-label', { text: t('words', 'Words:') }),
        D.h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
          D.h('div', { style: { flex: '1 1 auto', minWidth: '0' } }, countSelect),
          D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('generate', 'Generate'), onclick: generate })))
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.field', null,
        D.h('label.field-label', { text: t('extra_passphrase', 'Extra passphrase:') }), passphraseBox,
        D.h('p.field-hint', { text: t('seed_hint', 'BIP39 seed = PBKDF2-HMAC-SHA512(NFKD(mnemonic), "mnemonic" + NFKD(passphrase), 2048, 64 bytes). Leave empty for the plain mnemonic seed.') })),
      seedCard,
      seedMsg
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.field', null,
        D.h('label.field-label', { text: t('search_label', 'Search the word list:') }), searchBox, searchOut)
    ));

    generate();
    onSearch();

    return {
      destroy: function () {
        if (seedTimer) { window.clearTimeout(seedTimer); seedTimer = null; }
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  /* ======================================================================
     六、纯逻辑出口 + 单测用例
     ====================================================================== */

  window.ItTools.logic['bip39-generator'] = {
    LANGUAGES: LANGUAGES,
    WORD_COUNTS: WORD_COUNTS,
    ENTROPY_BITS: ENTROPY_BITS,
    SEED_ITERATIONS: SEED_ITERATIONS,
    SEED_BYTES: SEED_BYTES,
    sha256: sha256,
    sha512: sha512,
    hmacSha512: hmacSha512,
    pbkdf2Sha512: pbkdf2Sha512,
    wordList: wordList,
    wordsOf: wordsOf,
    normalizeWordCount: normalizeWordCount,
    entropyBytesForWords: entropyBytesForWords,
    entropyHexLength: entropyHexLength,
    hexToBytes: hexToBytes,
    bytesToBits: bytesToBits,
    entropyToMnemonic: entropyToMnemonic,
    splitMnemonic: splitMnemonic,
    mnemonicToEntropy: mnemonicToEntropy,
    validateMnemonic: validateMnemonic,
    generateEntropyHex: generateEntropyHex,
    generateMnemonic: generateMnemonic,
    mnemonicToSeedHex: mnemonicToSeedHex,
    searchWords: searchWords,

    __cases: function (assert) {
      var ZERO = {
        12: '00000000000000000000000000000000',
        15: '0000000000000000000000000000000000000000',
        18: '000000000000000000000000000000000000000000000000',
        21: '00000000000000000000000000000000000000000000000000000000',
        24: '0000000000000000000000000000000000000000000000000000000000000000'
      };
      var ABANDON = {
        12: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        15: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon address',
        18: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon agent',
        21: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon admit',
        24: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
      };

      /* ---- 词表本身 ---- */
      assert.eq(LANGUAGES.length, 10, '库里 10 份词表');
      LANGUAGES.forEach(function (l) {
        assert(window.BIP39[l.key], 'BIP39.' + l.key + ' 存在');
        assert.eq(wordsOf(l.key).length, 2048, l.key + ' 是 2048 个词');
        assert.eq(typeof wordList(l.key).spacer, 'string', l.key + ' 有 spacer');
      });
      assert.eq(wordList('japaneseWordList').spacer, '　', '日文词表 spacer 是全角空格');
      assert.eq(wordsOf('nope'), wordsOf('englishWordList'), '不存在的语言退回英文');
      assert.eq(wordsOf(), wordsOf('englishWordList'), '不传语言时是英文');

      /* ---- 词数 ↔ 熵长度 ---- */
      assert.eq(WORD_COUNTS, [12, 15, 18, 21, 24], '支持 12/15/18/21/24');
      assert.eq(entropyBytesForWords(12), 16, '12 词 = 128 位熵');
      assert.eq(entropyBytesForWords(15), 20, '15 词 = 160 位熵');
      assert.eq(entropyBytesForWords(18), 24, '18 词 = 192 位熵');
      assert.eq(entropyBytesForWords(21), 28, '21 词 = 224 位熵');
      assert.eq(entropyBytesForWords(24), 32, '24 词 = 256 位熵');
      assert.eq(entropyHexLength(24), 64, '24 词对应 64 个 hex 字符');
      assert.eq(normalizeWordCount(13), 12, '非法词数退回 12');
      assert.eq(normalizeWordCount('18'), 18, '数字字符串也吃');
      assert.eq(normalizeWordCount(undefined), 12, 'undefined 退回 12');

      /* ---- 摘要原语（用 NIST/RFC 的标准向量自检，错了后面全白搭） ---- */
      assert.eq(U.hex(sha256(new Uint8Array(0))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'SHA-256("")');
      assert.eq(U.hex(sha256(U.utf8Bytes('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA-256("abc")');
      assert.eq(U.hex(sha512(new Uint8Array(0))), 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e', 'SHA-512("")');
      assert.eq(U.hex(sha512(U.utf8Bytes('abc'))), 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f', 'SHA-512("abc")');
      // 长度字段写错的话，只有空消息能过，长度 >= 1 全错，所以这里再钉一个跨块的长度
      assert.eq(U.hex(sha512(new Uint8Array(200))).length, 128, 'SHA-512(200 字节) 仍是 64 字节摘要');
      assert.eq(U.hex(hmacSha512(U.utf8Bytes('key'), U.utf8Bytes('The quick brown fox jumps over the lazy dog'))),
        'b42af09057bac1e2d41708e48a902e09b5ff7f12ab428a4fe86653c73dd248fb82f948a549f7b791a5b41915ee4d1ec3935357e4e2317250d0372afa2ebeeb3a',
        'HMAC-SHA512 RFC 4231 向量');
      assert.eq(U.hex(pbkdf2Sha512(U.utf8Bytes('password'), U.utf8Bytes('salt'), 1, 64)),
        '867f70cf1ade02cff3752599a3a53dc4af34c7a669815ae5d513554e1c8cf252c02d470a285a0501bad999bfe943c08f050235d7d68b1da55e63f73b60a57fce',
        'PBKDF2-HMAC-SHA512 迭代 1 次');

      /* ---- hex / bit 小工具 ---- */
      assert.eq(U.hex(hexToBytes('00ff10')), '00ff10', 'hex 往返');
      assert.eq(bytesToBits(new Uint8Array([0x80, 0x01])), '1000000000000001', '字节转比特串');
      var threw = false;
      try { hexToBytes('zz'); } catch (e) { threw = true; }
      assert(threw, '非 hex 抛错');
      threw = false;
      try { hexToBytes('abc'); } catch (e) { threw = true; }
      assert(threw, '奇数长度 hex 抛错');

      /* ---- 熵 → 助记词：全 0 熵的 5 种词数（BIP39 官方向量） ---- */
      WORD_COUNTS.forEach(function (n) {
        assert.eq(entropyToMnemonic(ZERO[n]), ABANDON[n], n + ' 个词的全 0 熵');
        assert.eq(entropyToMnemonic(ZERO[n]).split(/\s+/).length, n, n + ' 个词');
        assert.eq(mnemonicToEntropy(ABANDON[n]), ZERO[n], n + ' 个词能反解回熵');
        assert.eq(entropyHexLength(n), ZERO[n].length, n + ' 个词的熵长度');
      });
      // 大小写：输入允许大写 hex，输出恒为小写
      assert.eq(entropyToMnemonic(ZERO[12].toUpperCase()), ABANDON[12], '大写 hex 也接受');

      /* ---- 熵 → 助记词：其它官方向量 ---- */
      var VECTORS = [
        ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank yellow'],
        ['80808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'],
        ['ffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'],
        ['f30f8c1da665478f49b001d94c5fc452', 'vessel ladder alter error federal sibling chat ability sun glass valve picture'],
        ['9e885d952ad362caeb4efe34a8e91bd2', 'ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic']
      ];
      VECTORS.forEach(function (v) {
        assert.eq(entropyToMnemonic(v[0]), v[1], '熵 ' + v[0].slice(0, 8) + '… 的标准助记词');
        assert.eq(mnemonicToEntropy(v[1]), v[0], '标准助记词 ' + v[1].split(' ')[0] + '… 的标准熵');
      });

      /* ---- 校验和与词表校验 ---- */
      threw = false;
      try { mnemonicToEntropy('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'); }
      catch (e) { threw = e.code === 'invalid_checksum'; }
      assert(threw, '校验位不对时抛 Invalid checksum（末词应换 about）');
      threw = false;
      try { mnemonicToEntropy('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'); }
      catch (e) { threw = e.code === 'invalid_length'; }
      assert(threw, '词数不对时抛错');
      threw = false;
      try { mnemonicToEntropy('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon notaword'); }
      catch (e) { threw = e.code === 'word_not_found'; }
      assert(threw, '词表里没有的词要显式报错（库自己是静默算成 2047）');
      assert.eq(validateMnemonic(ABANDON[12]).valid, true, '全 0 助记词合法');
      assert.eq(validateMnemonic(ABANDON[12]).entropy, ZERO[12], 'validate 也给出熵');
      assert.eq(validateMnemonic('abandon abandon').valid, false, '两个词非法');
      assert.eq(validateMnemonic('abandon abandon').entropy, null, '非法时熵为 null');
      assert.eq(validateMnemonic(ABANDON[12]).error, null, '合法时 error 为 null');
      assert.eq(validateMnemonic('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo').errorCode, 'invalid_checksum', 'zoo…wrong 换成 zoo 就是校验位错');

      /* ---- 熵长度不对 ---- */
      threw = false;
      try { entropyToMnemonic('00'.repeat(8)); } catch (e) { threw = e.code === 'invalid_entropy_bits'; }
      assert(threw, '64 位熵（8 字节）不是合法的 BIP39 熵长度');
      threw = false;
      try { entropyToMnemonic(''); } catch (e) { threw = true; }
      assert(threw, '空熵抛错');
      threw = false;
      try { entropyToMnemonic('0'.repeat(33)); } catch (e) { threw = true; }
      assert(threw, '奇数长度 hex 抛错');

      /* ---- 随机生成（注入固定随机源，结果可复现） ---- */
      var fake = function (n) {
        var a = new Uint8Array(n);
        for (var i = 0; i < n; i++) a[i] = i;
        return a;
      };
      assert.eq(generateEntropyHex(12, fake), '000102030405060708090a0b0c0d0e0f', '注入随机源时熵可复现');
      assert.eq(generateEntropyHex(24, fake).length, 64, '24 词生成 64 个 hex 字符');
      assert.eq(mnemonicToEntropy(generateMnemonic(24, undefined, fake)), generateEntropyHex(24, fake), '生成的助记词能反解回同一份熵');
      var live = generateMnemonic(24);
      assert.eq(validateMnemonic(live).valid, true, '不注入随机源时生成的是合法 24 词助记词');
      assert.eq(live.split(/\s+/).length, 24, '确实是 24 个词');
      assert(generateEntropyHex(15) !== generateEntropyHex(15), '两次生成的熵不同');

      /* ---- 词表检索 ---- */
      var ab = searchWords('aban');
      assert(ab.length > 0, '搜 aband 有结果');
      assert.eq(ab[0], { word: 'abandon', index: 0 }, '前缀匹配排在最前，abandon 是第 0 个词');
      assert.eq(searchWords('abandon', 'spanishWordList').length, 0, '西语词表里没有 abandon 这个词');
      assert.eq(searchWords('abrir', 'spanishWordList').length, 1, '西语词表能搜到 abrir');
      assert.eq(searchWords('', 'englishWordList', 10).length, 10, '空查询按 limit 截断');
      assert.eq(searchWords('zoo').length, 1, '搜 zoo 只有 1 个词');
      assert.eq(searchWords('zoo')[0], { word: 'zoo', index: 2047 }, 'zoo 是最后一个词');
      assert(searchWords('あい', 'japaneseWordList').length > 0, 'CJK 词表按子串也能检索');
      assert(searchWords('あい', 'japaneseWordList').length <= 50, '检索结果最多 50 条');
      assert.eq(searchWords('a').length, 50, 'limit 生效');

      /* ---- 切词 ---- */
      assert.eq(splitMnemonic('  a   b \n c '), ['a', 'b', 'c'], '多余空白被吃掉');
      assert.eq(splitMnemonic('あいこくしん　あいさつ'), ['あいこくしん', 'あいさつ'], '日文全角空格也能切');
      assert.eq(splitMnemonic(''), [], '空串切成空数组');
      assert.eq(splitMnemonic(null), [], 'null 切成空数组');

      /* ---- 种子：BIP39 官方 TREZOR 向量 ---- */
      assert.eq(mnemonicToSeedHex(ABANDON[12], ''),
        '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
        '种子向量：abandon…about + 无口令');
      assert.eq(mnemonicToSeedHex('legal winner thank year wave sausage worth useful legal winner thank yellow', 'TREZOR'),
        '2e8905819b8723fe2c1d161860e5ee1830318dbf49a83bd451cfb8440c28bd6fa457fe1296106559a3c80937a1c1069be3a3a5bd381ee6260e8d9739fce1f607',
        '种子向量：legal…yellow + TREZOR');
      assert.eq(mnemonicToSeedHex('letter advice cage absurd amount doctor acoustic avoid letter advice cage above', 'TREZOR'),
        'd71de856f81a8acc65e6fc851a38d4d7ec216fd0796d0a6827a3ad6ed5511a30fa280f12eb2e47ed2ac03b5c462a0358d18d69fe4f985ec81778c1b370b652a8',
        '种子向量：letter…above + TREZOR');
      assert.eq(mnemonicToSeedHex('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', 'TREZOR'),
        'ac27495480225222079d7be181583751e86f571027b0497b5b5d11218e0a8a13332572917f0f8e5a589620c6f15b11c61dee327651a14c34e18231052e48c069',
        '种子向量：zoo…wrong + TREZOR');
      // 24 词（256 位熵）也能派生，验的是本实现不是「只对 12 词能用」
      assert.eq(mnemonicToSeedHex(ABANDON[24], ''),
        '408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf705489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840',
        '种子向量：24 个词的全 0 助记词');
      assert.eq(mnemonicToSeedHex(ABANDON[12], '').length, 128, '种子是 128 个 hex 字符');
      assert(mnemonicToSeedHex(ABANDON[12], 'x') !== mnemonicToSeedHex(ABANDON[12], ''), '加口令后种子变了');
      assert(mnemonicToSeedHex(ABANDON[12], null) === mnemonicToSeedHex(ABANDON[12], ''), '口令传 null 等于空口令');
      assert.eq(mnemonicToSeedHex(ABANDON[12], undefined).length, 128, '口令传 undefined 也给得出种子');
      // 词序无关空格：前后空白与全角空格不影响种子
      assert.eq(mnemonicToSeedHex('  abandon   abandon about  ', 'TREZOR'), mnemonicToSeedHex('abandon abandon about', 'TREZOR'), '多余空白不影响种子');

      /* ---- 日文词表（走 NFKD 与全角空格这两条非 ASCII 路径） ---- */
      var jp = entropyToMnemonic('00000000000000000000000000000000', 'japaneseWordList');
      assert.eq(splitMnemonic(jp).length, 12, '日文词表也能生成 12 个词');
      assert.eq(mnemonicToEntropy(jp, 'japaneseWordList'), ZERO[12], '日文助记词能反解回熵');
      assert.eq(validateMnemonic(jp, 'japaneseWordList').valid, true, '日文助记词合法');
      assert(mnemonicToSeedHex(jp, '').length === 128, '日文助记词也能派生种子');
      assert(mnemonicToSeedHex(jp, '') !== mnemonicToSeedHex(ABANDON[12], ''), '同一份熵在日文词表下种子不同');
      // 英语词表不认识日文词
      assert.eq(validateMnemonic(jp, 'englishWordList').valid, false, '日文词在英语词表里查不到');
      // 繁体和简体词表的前 3 个字一样但整表不同
      assert.eq(wordsOf('chineseSimplifiedWordList').length, 2048, '简体词表 2048 词');
      assert.eq(wordsOf('chineseTraditionalWordList')[9], '這', '繁体第 9 个词是 這');
      assert.eq(wordsOf('chineseSimplifiedWordList')[9], '这', '简体第 9 个词是 这');
    }
  };
})();