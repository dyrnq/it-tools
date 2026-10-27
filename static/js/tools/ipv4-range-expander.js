/* ==========================================================================
   IPv4 段展开器（ipv4-range-expander）

   输入起止两个 IPv4，算出包含这段地址的最小 CIDR 块，并把段内地址逐条列出。

   参考实现：src/tools/ipv4-range-expander/（it-tools, GPLv3）
   与原版的差别：
   1. 原版只给「包住整段的最小单个 CIDR」。一段地址在数学上常常需要多个 CIDR
      才能精确覆盖（比如 10.0.0.1 ~ 10.0.0.6 要 /32×2 + /31），原版一律
      向上取整成 /29。这里保留原版的单块语义（它是这个工具的主输出），
      但把整段的地址清单也列出来，向上取整丢掉的部分一眼可见。
   2. 原版没有任何展开上限。这里给展开加 MAX_ADDRESSES 上限，超限只列前
      MAX_ADDRESSES 条并明确提示，避免 0.0.0.0~255.255.255.255 把页面撑死。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('ipv4-range-expander');

  /** 展开清单的最大条数；超过就截断并提示。 */
  var MAX_ADDRESSES = 1000;

  function isValidIpv4(ip) {
    if (typeof ip !== 'string') return false;
    var parts = ip.trim().split('.');
    if (parts.length !== 4) return false;
    return parts.every(function (p) {
      return /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255;
    });
  }

  function ipv4ToInt(ip) {
    if (!isValidIpv4(ip)) return null;
    return ip.trim().split('.').reduce(function (acc, part, i) {
      return acc + Number(part) * Math.pow(256, 3 - i);
    }, 0);
  }

  function intToIpv4(num) {
    return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
  }

  /**
   * 主函数：算出包住 [startIp, endIp] 的最小 CIDR 块。
   * 思路与参考实现一致：起止地址的 32 位二进制表示的最长公共前缀长度即前缀长度。
   * @returns {?{oldSize: number, newSize: number, newStart: string, newEnd: string, newCidr: string}}
   *          起始大于结束或任一地址非法时返回 null
   */
  function calculateCidr(startIp, endIp) {
    var start = ipv4ToInt(startIp);
    var end = ipv4ToInt(endIp);
    if (start === null || end === null) return null;
    // 闭区间的地址个数 = 末 - 首 + 1；末 < 首时结果为 0 或负数，判掉
    if (end < start) return null;

    var size = end - start + 1;

    // 起止相同的时候 32 位全同，for 循环不会 break，prefix 保持 32
    var prefix = 32;
    for (var i = 0; i < 32; i++) {
      if (((start >>> (31 - i)) & 1) !== ((end >>> (31 - i)) & 1)) { prefix = i; break; }
    }

    var hostBits = 32 - prefix;
    var newStart = prefix === 0 ? 0 : start - (start % Math.pow(2, hostBits));
    var newEnd = newStart + Math.pow(2, hostBits) - 1;

    return {
      oldSize: size,
      newSize: Math.pow(2, hostBits),
      newStart: intToIpv4(newStart),
      newEnd: intToIpv4(newEnd),
      newCidr: intToIpv4(newStart) + '/' + prefix
    };
  }

  /**
   * 把 [startIp, endIp] 逐条展开成地址列表。
   * @returns {{addresses: string[], total: number, truncated: boolean}}
   *          total 是段内地址的真实总数，truncated 表示 addresses 被上限截断过
   */
  function expandRange(startIp, endIp, limit) {
    var cap = limit === undefined ? MAX_ADDRESSES : limit;
    var start = ipv4ToInt(startIp);
    var end = ipv4ToInt(endIp);
    if (start === null || end === null || end < start) {
      return { addresses: [], total: 0, truncated: false };
    }
    var total = end - start + 1;
    var take = Math.min(total, cap);
    var addresses = [];
    for (var n = 0; n < take; n++) addresses.push(intToIpv4(start + n));
    return { addresses: addresses, total: total, truncated: take < total };
  }

  window.ItTools.register('ipv4-range-expander', function (root) {
    var startInput = D.h('input.layui-input', {
      type: 'text', value: '192.168.1.1', spellcheck: 'false', placeholder: t('start_ph', 'Start IPv4 address...')
    });
    var endInput = D.h('input.layui-input', {
      type: 'text', value: '192.168.6.255', spellcheck: 'false', placeholder: t('end_ph', 'End IPv4 address...')
    });
    var output = D.h('div');

    /** 结果表的一行：标签 + 原值 + 新值（可复制）。 */
    function resultRow(label, oldValue, newValue) {
      function cell(value) {
        var box = D.h('input.layui-input', { type: 'text', readonly: true, value: value });
        return D.h('td', null, D.h('div.input-group', null, box, U.copyButton(function () { return box.value; })));
      }
      return D.h('tr', null,
        D.h('td', { text: label }),
        cell(oldValue),
        cell(newValue)
      );
    }

    function render() {
      D.clear(output);
      var startIp = startInput.value;
      var endIp = endInput.value;

      if (!isValidIpv4(startIp) || !isValidIpv4(endIp)) {
        // 原版出错时是一条 n-alert，不是普通的一行提示
        output.appendChild(U.alert('error', null, t('invalid_ipv4', 'Invalid IPv4 address')));
        return;
      }

      var cidr = calculateCidr(startIp, endIp);
      if (!cidr) {
        // 原版这里是 n-alert + 一个「对调起止地址」的按钮
        output.appendChild(D.h('div.field', null,
          U.alert('error',
            t('end_before_start_title', 'Invalid combination of start and end IPv4 address'),
            t('end_before_start', 'The end IPv4 address is lower than the start IPv4 address. This is not valid and no result could be calculated.')),
          D.h('div.form-actions', null,
            D.h('button.layui-btn.layui-btn-sm.layui-btn-normal', {
              type: 'button', text: t('switch_addresses', 'Switch start and end IPv4 address'),
              onclick: function () {
                var tmp = startInput.value;
                startInput.value = endInput.value;
                endInput.value = tmp;
                render();
              }
            }))
        ));
        return;
      }

      function num(n) { return n.toLocaleString('en-US'); }

      output.appendChild(D.h('table.result-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', null, D.h('span', { text: '' })),
          D.h('th', { text: t('old_value', 'old value') }),
          D.h('th', { text: t('new_value', 'new value') })
        )),
        D.h('tbody', null,
          resultRow(t('start_address', 'Start address'), startIp.trim(), cidr.newStart),
          resultRow(t('end_address', 'End address'), endIp.trim(), cidr.newEnd),
          resultRow(t('addresses_in_range', 'Addresses in range'), num(cidr.oldSize), num(cidr.newSize)),
          resultRow(t('cidr', 'CIDR'), '', cidr.newCidr)
        )
      ));

      var expanded = expandRange(startIp, endIp);
      output.appendChild(D.h('div.form-actions', null,
        D.h('span.badge-note', {
          text: t('expanded', 'Expanded {shown} / {total} addresses')
            .replace('{shown}', num(expanded.addresses.length))
            .replace('{total}', num(expanded.total))
        })
      ));
      if (expanded.truncated) {
        output.appendChild(D.h('p.field-hint', {
          text: t('truncated', 'Range is larger than {max} addresses, only the first {shown} are listed.')
            .replace('{max}', num(MAX_ADDRESSES))
            .replace('{shown}', num(expanded.addresses.length))
        }));
      }
      output.appendChild(D.h('pre.mono-output', { text: expanded.addresses.join('\n') }));
    }

    startInput.addEventListener('input', render);
    endInput.addEventListener('input', render);

    // 原版这两个框是 c-input-text，标签在**上面**一行（c-label 的默认
    // label-position="top"），不是左标签。
    root.appendChild(D.h('div.card', null,
      U.field(t('start_address', 'Start address'), startInput, { wide: true }),
      U.field(t('end_address', 'End address'), endInput, { wide: true }),
      output
    ));
    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['ipv4-range-expander'] = {
    calculateCidr: calculateCidr,
    expandRange: expandRange,
    MAX_ADDRESSES: MAX_ADDRESSES,
    __cases: function (assert) {
      // 与参考实现的 vitest / e2e 用例一致
      var r = calculateCidr('192.168.1.1', '192.168.7.255');
      assert.eq(r.oldSize, 1791, '原段大小');
      assert.eq(r.newSize, 2048, '取整后大小');
      assert.eq(r.newStart, '192.168.0.0', '取整后首地址');
      assert.eq(r.newEnd, '192.168.7.255', '取整后末地址');
      assert.eq(r.newCidr, '192.168.0.0/21', 'CIDR');

      var r2 = calculateCidr('10.0.0.1', '10.0.0.17');
      assert.eq(r2.oldSize, 17, '首字节小于 128 时的原段大小');
      assert.eq(r2.newSize, 32, '取整后大小');
      assert.eq(r2.newStart, '10.0.0.0', '取整后首地址');
      assert.eq(r2.newEnd, '10.0.0.31', '取整后末地址');
      assert.eq(r2.newCidr, '10.0.0.0/27', 'CIDR');

      assert.eq(calculateCidr('192.168.7.1', '192.168.6.255'), null, '结束早于开始');
      assert.eq(calculateCidr('192.168.7.1', 'bogus'), null, '非法地址');

      // 边界：单点、整段全空间
      assert.eq(calculateCidr('1.2.3.4', '1.2.3.4'), {
        oldSize: 1, newSize: 1, newStart: '1.2.3.4', newEnd: '1.2.3.4', newCidr: '1.2.3.4/32'
      }, '起止相同得 /32');
      assert.eq(calculateCidr('0.0.0.0', '255.255.255.255').newCidr, '0.0.0.0/0', '全空间得 /0');
      assert.eq(calculateCidr('0.0.0.0', '255.255.255.255').newSize, 4294967296, '全空间大小');

      // 展开
      var e = expandRange('10.0.0.1', '10.0.0.3');
      assert.eq(e.addresses, ['10.0.0.1', '10.0.0.2', '10.0.0.3'], '逐条展开');
      assert.eq(e.total, 3, '总数');
      assert.eq(e.truncated, false, '未截断');
      assert.eq(expandRange('10.0.0.1', '10.0.0.3').addresses.length, 3, '展开条数');
      assert.eq(expandRange('bogus', '10.0.0.3').addresses, [], '非法起址不展开');
      assert.eq(expandRange('10.0.0.3', '10.0.0.1').addresses, [], '结束早于开始不展开');

      // 上限：默认 1000 条，超出只给前 1000 条并标记截断
      var big = expandRange('10.0.0.0', '10.0.4.0');
      assert.eq(big.addresses.length, MAX_ADDRESSES, '默认上限 1000');
      assert.eq(big.total, 1025, '真实总数不受上限影响');
      assert.eq(big.truncated, true, '超限要标记');
      assert.eq(big.addresses[0], '10.0.0.0', '截断后仍从首地址开始');
      assert.eq(big.addresses[MAX_ADDRESSES - 1], '10.0.3.231', '截断点的地址');
      assert.eq(expandRange('10.0.0.0', '10.0.0.255').truncated, false, '刚好不超限不标记');
      assert.eq(expandRange('10.0.0.0', '10.0.4.0', 3).addresses, ['10.0.0.0', '10.0.0.1', '10.0.0.2'], '上限可传参');
    }
  };
})();