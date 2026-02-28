export function toBigIntBE(buf) {
    return BigInt('0x' + buf.toString('hex'));
}

export function toBigIntLE(buf) {
    return BigInt('0x' + Buffer.from(buf).reverse().toString('hex'));
}

export function toBufferBE(num, width) {
    let hex = num.toString(16);
    if (hex.length % 2 !== 0) hex = '0' + hex;
    const buf = Buffer.from(hex, 'hex');
    if (buf.length >= width) return buf.subarray(buf.length - width);
    const res = Buffer.alloc(width);
    buf.copy(res, width - buf.length);
    return res;
}

export function toBufferLE(num, width) {
    const buf = toBufferBE(num, width);
    return buf.reverse();
}
