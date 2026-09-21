/*
 * 一次性验证：把实测抓到的真实报错喂给 explainModelError，确认翻译正确。
 * 用真实的 renderer.js 源码求值，避免复制粘贴导致漂移。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');

// 只取 ERROR_HINTS 与 explainModelError 两段来求值
const start = src.indexOf('const ERROR_HINTS');
const end = src.indexOf('async function testModelConnection');
const snippet = src.slice(start, end);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(snippet + '\nthis.explainModelError = explainModelError;', sandbox);
const explain = sandbox.explainModelError;

// 以下全部是真实抓到的响应原文
const cases = [
  {
    name: '阿里云欠费（截图里的报错）',
    raw: 'RuntimeError: vision request failed: HTTP 400 {"error":{"message":'
       + '"Access denied, please make sure your account is in good standing. '
       + 'For details, see: https://help.aliyun.com/zh/model-studio/error-code'
       + '#overdue-payment","type":"Arrearage","param":null,"code":"Arrearage"},'
       + '"request_id":"8605e472-81b4-9cd7-b04d-878e89847c14"}',
    expect: '欠费',
  },
  {
    name: '限流',
    raw: 'RetryableError: HTTP 429: {"error":{"message":"You have exceeded your current '
       + 'request limit. For details, see: https://help.aliyun.com/zh/model-studio/'
       + 'error-code#rate-limit","type":"limit_requests","code":"limit_requests"}}',
    expect: '限流',
  },
  {
    name: '图片尺寸不合规',
    raw: 'RuntimeError: vision request failed: HTTP 400 {"error":{"message":'
       + '"<400> InternalError.Algo.InvalidParameter: The image length and width '
       + 'do not meet the model restrictions. [height:1 or width:1 must be larger '
       + 'than 10]","code":"invalid_parameter_error"}}',
    expect: '尺寸',
  },
  {
    name: 'Key 无效',
    raw: 'RuntimeError: vision request failed: HTTP 401 {"error":{"message":'
       + '"InvalidApiKey","type":"invalid_request_error"}}',
    expect: 'Key 无效',
  },
  {
    name: '模型名不存在',
    raw: 'RuntimeError: vision request failed: HTTP 400 {"error":{"message":'
       + '"Model not found: foo-bar","type":"invalid_request_error"}}',
    expect: '模型名不存在',
  },
  {
    name: '未知错误（应无翻译，保留原文）',
    raw: 'RuntimeError: 某种没见过的错误',
    expect: '',
  },
];

let pass = 0;
console.log('=== 错误翻译验证 ===\n');
for (const c of cases) {
  const hint = explain(c.raw);
  const ok = c.expect ? hint.includes(c.expect) : hint === '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (hint) console.log(`      -> ${hint.replace(/\n/g, '\n         ')}`);
  else console.log('      -> (无翻译，直接显示原文)');
  console.log();
  if (ok) pass += 1;
}
console.log(`合计 ${cases.length} 项，通过 ${pass}，失败 ${cases.length - pass}`);
process.exit(pass === cases.length ? 0 : 1);
