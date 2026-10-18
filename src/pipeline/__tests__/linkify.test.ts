import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { linkify } from '../../lib/linkify';

describe('an install\'s own words, with their links', () => {
  it('links email addresses and web links, and leaves a sentence\'s full stop out of them', () => {
    assert.deepEqual(linkify('To become a tester, email developer@healthiercloud.com. More at https://example.org/join.'), [
      { text: 'To become a tester, email ' },
      { text: 'developer@healthiercloud.com', href: 'mailto:developer@healthiercloud.com' },
      { text: '. More at ' },
      { text: 'https://example.org/join', href: 'https://example.org/join' },
      { text: '.' },
    ]);
  });

  it('leaves text without links as it is, markup included', () => {
    assert.deepEqual(linkify('Testing <b>only</b>'), [{ text: 'Testing <b>only</b>' }]);
    assert.deepEqual(linkify(''), []);
  });
});
