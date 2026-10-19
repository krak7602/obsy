import { describe, expect, it } from 'vite-plus/test';

import { childElement, childText, decodeXmlText, parseXml } from './xml';

describe('parseXml', () => {
  it('parses a ListObjectsV2 response with namespaces and a declaration', () => {
    const root = parseXml(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        '<Name>b</Name><IsTruncated>true</IsTruncated>' +
        '<Contents><Key>a&amp;b</Key><ETag>&quot;e1&quot;</ETag></Contents>' +
        '<Contents><Key>c</Key></Contents>' +
        '<NextContinuationToken>1/abc+def=</NextContinuationToken>' +
        '</ListBucketResult>',
    );
    expect(root.name).toBe('ListBucketResult');
    expect(childText(root, 'IsTruncated')).toBe('true');
    const contents = root.children.filter((child) => child.name === 'Contents');
    expect(contents.map((element) => childText(element, 'Key'))).toEqual(['a&b', 'c']);
    expect(childText(contents[0] ?? root, 'ETag')).toBe('"e1"');
    expect(childText(root, 'NextContinuationToken')).toBe('1/abc+def=');
  });

  it('keeps whitespace inside text exactly', () => {
    const root = parseXml('<R><Key>  two  spaces </Key></R>');
    expect(childText(root, 'Key')).toBe('  two  spaces ');
  });

  it('handles comments, CDATA, self-closing tags, and quoted ">" in attributes', () => {
    const root = parseXml(
      '<!-- leading --><a:Root x="1>2" y=\'<\'><Empty/><Data><![CDATA[<raw & text>]]></Data>' +
        '<!-- inner --><Text>x&lt;y</Text></a:Root>',
    );
    expect(root.name).toBe('Root');
    expect(childElement(root, 'Empty')).toEqual({ name: 'Empty', children: [], text: '' });
    expect(childText(root, 'Data')).toBe('<raw & text>');
    expect(childText(root, 'Text')).toBe('x<y');
  });

  it('decodes numeric character references, including astral code points', () => {
    expect(decodeXmlText('&#65;&#x42;&#x1F600;&#233;&apos;')).toBe("AB\u{1F600}é'");
  });

  it('rejects malformed or unsafe input', () => {
    const bad = [
      '<a><b></a></b>',
      '<a>',
      '<a></a><b></b>',
      'text<a></a>',
      '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>',
      '<a>&unknown;</a>',
      '<a>&amp</a>',
      '<a>&#0;</a>',
      '<a',
      '',
    ];
    const accepted = bad.filter((source) => {
      try {
        parseXml(source);
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted).toEqual([]);
  });
});
