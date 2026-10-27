/*
 * 生成 JWT 的测试向量（Node 的 crypto 底层是 OpenSSL —— 跨实现的权威参照）。
 *
 * **产物里只有公开材料**：共享口令、公钥、OpenSSL 签出来的签名向量。
 * 私钥只在脚本的内存里用一次（签名得用它），签完就丢 —— 仓库里不放私钥。
 *
 * 为什么不放：这个仓库是公开的，而 GitHub 对公开仓库默认开着 push protection，
 * 一段 `-----BEGIN PRIVATE KEY-----` 就能把**第一次推送整个拦下来**。
 * 而且这把钥匙本来就是这里现生成的一次性货色，留着没有任何价值：
 * 互操作性的证据是「OpenSSL 签的签名，我们验得过」加上对应的公钥 ——
 * 私钥不在证据链上。测试要私钥的地方，一律在测试里现生成一把。
 */
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const HEADER = { alg: 'HS256', typ: 'JWT' };
const PAYLOAD = { sub: '1234567890', name: 'John Doe', iat: 1516239022 };

// 固定 JSON 序列化（与 Rust 侧 serde_json 的紧凑输出一致：键序按插入序，无空格）
const json = (o) => JSON.stringify(o);
const headerFor = (alg) => json({ alg, typ: 'JWT' });
const payloadStr = json(PAYLOAD);

const SECRET = 'your-256-bit-secret-!!';

// ---- 密钥（脚本内现生成，私钥用完即弃） ----
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ec = {};
for (const [name, curve, hash] of [['P-256','prime256v1','sha256'],['P-384','secp384r1','sha384'],['P-521','secp521r1','sha512']]) {
  ec[name] = crypto.generateKeyPairSync('ec', { namedCurve: curve,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
}

// DER -> raw R||S
function derToRaw(der, size) {
  let o = 0;
  if (der[o++] !== 0x30) throw new Error('not a sequence');
  if (der[o] & 0x80) {
    const n = der[o++] & 0x7f;
    for (let i = 0; i < n; i++) o++;
  } else o++;
  function readInt() {
    if (der[o++] !== 0x02) throw new Error('not an integer');
    const len = der[o++];
    let v = der.slice(o, o + len); o += len;
    while (v.length && v[0] === 0) v = v.slice(1);
    return v;
  }
  const r = readInt(), s = readInt();
  const raw = Buffer.concat([Buffer.alloc(size - r.length), r, Buffer.alloc(size - s.length), s]);
  return raw;
}

const out = {};
for (const alg of ['HS256','HS384','HS512','RS256','RS384','RS512','PS256','PS384','PS512','ES256','ES384','ES512']) {
  const input = b64u(Buffer.from(headerFor(alg))) + '.' + b64u(Buffer.from(payloadStr));
  let sig, hash = 'sha' + alg.slice(2);
  if (alg.startsWith('HS')) {
    sig = crypto.createHmac(hash, SECRET).update(input).digest();
  } else if (alg.startsWith('RS')) {
    sig = crypto.createSign(hash).update(input).sign(rsa.privateKey);
  } else if (alg.startsWith('PS')) {
    sig = crypto.createSign(hash).update(input).sign({ key: rsa.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
  } else {
    const curve = alg === 'ES256' ? 'P-256' : alg === 'ES384' ? 'P-384' : 'P-521';
    const size = alg === 'ES256' ? 32 : alg === 'ES384' ? 48 : 66;
    const der = crypto.createSign(hash).update(input).sign(ec[curve].privateKey);
    sig = derToRaw(der, size);
  }
  out[alg] = { input, sig: sig.toString('base64url') };
}

// 产物里**没有私钥**（见文件头的说明）：签名向量是私钥的产物，
// 但私钥本身不落盘 —— 只有公钥与签名留在仓库里。
console.log(JSON.stringify({
  secret: SECRET,
  payload: payloadStr,
  rsaPublicPem: rsa.publicKey,
  ecPublicPem: Object.fromEntries(Object.entries(ec).map(([k,v]) => [k, v.publicKey])),
  vectors: out,
}, null, 2));
