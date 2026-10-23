const {test}=require('node:test');const assert=require('node:assert/strict');const {parseId,safeName}=require('../core');
test('accept video IDs and links',()=>{assert.equal(parseId('BV1xx411c7mD'),'bvid=BV1xx411c7mD');assert.equal(parseId('https://www.bilibili.com/video/av170001?p=2'),'aid=170001');assert.throws(()=>parseId('https://example.com'));});
test('sanitize Windows file names',()=>{assert.equal(safeName('CON'),'_CON');assert.equal(safeName('a/b:c*?'),'a_b_c__');assert.equal(safeName('...'),'video');assert.equal(safeName('hello. '),'hello');});
