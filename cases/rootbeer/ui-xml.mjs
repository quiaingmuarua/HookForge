// UIAutomator may use single quotes when an attribute contains JSON quotes.
export function readUiAttribute(node, name) {
  const value = node?.match(new RegExp('\\b' + name + '=(["\'])(.*?)\\1'))?.[2];
  if (value === undefined) {
    return null;
  }
  const entities = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
  return value.replace(/&(#x[\da-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (_, entity) =>
    entity[0] === '#'
      ? String.fromCodePoint(
          entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
        )
      : entities[entity.toLowerCase()]
  );
}

// The sample publishes its verdict during the final row animation. An absent
// verdict or repeat button is an unfinished UI, never a restored negative.
export function readCompletedRootBeerUi(xml, expectedRows) {
  const nodes = xml.match(/<node\b[^>]*>/g) ?? [];
  const id = name => 'com.scottyab.rootbeer.sample:id/' + name;
  const rows = nodes.filter(node => readUiAttribute(node, 'resource-id') === id('rootItemText'));
  const find = name => nodes.find(node => readUiAttribute(node, 'resource-id') === id(name));
  if (rows.length !== expectedRows || !find('fab')) {
    return null;
  }
  return readUiAttribute(find('isRootedTextView'), 'text');
}
