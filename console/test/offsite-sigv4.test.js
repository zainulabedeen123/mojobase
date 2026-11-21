// AWS Signature Version 4 against AWS's published examples: the SigV4 test
// suite (credentials AKIDEXAMPLE) and the S3 "Authenticating requests" examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, sha256Hex, EMPTY_SHA256, canonicalQuery, uriEncode } from '../src/offsite/sigv4.js';

const suite = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  date: new Date('2015-08-30T12:36:00Z'),
};
const s3 = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
  date: new Date('2013-05-24T00:00:00Z'),
};

test('SigV4 test suite: get-vanilla', () => {
  const r = sign({
    ...suite,
    method: 'GET',
    path: '/',
    headers: { Host: 'example.amazonaws.com' },
  });
  assert.equal(
    r.canonicalRequest,
    'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n' +
      EMPTY_SHA256
  );
  assert.equal(
    r.stringToSign,
    'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63'
  );
  assert.equal(
    r.headers.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
  );
});

test('SigV4 test suite: get-vanilla-query-order-key-case', () => {
  const r = sign({
    ...suite,
    method: 'GET',
    path: '/',
    query: [
      ['Param2', 'value2'],
      ['Param1', 'value1'],
    ],
    headers: { Host: 'example.amazonaws.com' },
  });
  assert.equal(r.signature, 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
});

test('S3 example: GET object with Range header', () => {
  const r = sign({
    ...s3,
    method: 'GET',
    path: '/test.txt',
    headers: { Host: 'examplebucket.s3.amazonaws.com', Range: 'bytes=0-9' },
  });
  assert.equal(r.headers['x-amz-content-sha256'], EMPTY_SHA256);
  assert.equal(
    r.headers.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
  );
});

test('S3 example: PUT object (encoded key, extra headers, payload hash)', () => {
  const body = 'Welcome to Amazon S3.';
  const r = sign({
    ...s3,
    method: 'PUT',
    path: '/test$file.text',
    headers: {
      Host: 'examplebucket.s3.amazonaws.com',
      Date: 'Fri, 24 May 2013 00:00:00 GMT',
      'x-amz-storage-class': 'REDUCED_REDUNDANCY',
    },
    payloadHash: sha256Hex(body),
  });
  assert.match(r.canonicalRequest, /^PUT\n\/test%24file\.text\n/);
  assert.equal(r.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('S3 example: GET bucket lifecycle (empty query value)', () => {
  const r = sign({
    ...s3,
    method: 'GET',
    path: '/',
    query: [['lifecycle', '']],
    headers: { Host: 'examplebucket.s3.amazonaws.com' },
  });
  assert.equal(r.signature, 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
});

test('S3 example: list objects (sorted query)', () => {
  const r = sign({
    ...s3,
    method: 'GET',
    path: '/',
    query: [
      ['max-keys', '2'],
      ['prefix', 'J'],
    ],
    headers: { Host: 'examplebucket.s3.amazonaws.com' },
  });
  assert.equal(r.signature, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

test('URI and query encoding follow RFC 3986', () => {
  assert.equal(uriEncode('a b/c~d*'), 'a%20b%2Fc~d%2A');
  assert.equal(uriEncode('a b/c', { keepSlash: true }), 'a%20b/c');
  assert.equal(uriEncode('ü'), '%C3%BC');
  assert.equal(
    canonicalQuery([
      ['b', '2'],
      ['a', 'x y'],
      ['a', '1'],
    ]),
    'a=1&a=x%20y&b=2'
  );
});
