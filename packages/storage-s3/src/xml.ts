/**
 * A small XML parser for S3 responses (ListObjectsV2 and error bodies).
 *
 * Workers have no `DOMParser`, so this parser is plain ECMAScript. It handles
 * the XML that S3-compatible services send: an XML declaration, elements,
 * attributes (ignored), self-closing tags, comments, CDATA, the five
 * predefined entities, and numeric character references. It rejects a
 * DOCTYPE, unknown entities, and mismatched tags instead of guessing.
 */

export interface XmlElement {
  /** Local name, without a namespace prefix. */
  name: string;
  children: XmlElement[];
  /** Concatenated character data directly inside this element. */
  text: string;
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decodes entity and character references in XML character data. */
export function decodeXmlText(raw: string): string {
  return raw.replace(/&([^;&\s]*);?/g, (match, name: string) => {
    if (!match.endsWith(';')) throw new XmlParseError(`Unterminated entity: ${match}`);
    const named = NAMED_ENTITIES[name];
    if (named !== undefined) return named;
    const numeric = /^#(?:x([0-9a-fA-F]+)|([0-9]+))$/.exec(name);
    if (numeric !== null) {
      const point =
        numeric[1] === undefined
          ? Number.parseInt(numeric[2] ?? '', 10)
          : Number.parseInt(numeric[1], 16);
      if (!isXmlChar(point)) throw new XmlParseError(`Invalid character reference: ${match}`);
      return String.fromCodePoint(point);
    }
    throw new XmlParseError(`Unknown entity: ${match}`);
  });
}

function isXmlChar(point: number): boolean {
  return (
    point === 0x9 ||
    point === 0xa ||
    point === 0xd ||
    (point >= 0x20 && point <= 0xd7ff) ||
    (point >= 0xe000 && point <= 0xfffd) ||
    (point >= 0x10000 && point <= 0x10ffff)
  );
}

function localName(qualified: string): string {
  const colon = qualified.indexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

/** Parses a document and returns its root element. */
export function parseXml(source: string): XmlElement {
  let position = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;

  const expectEnd = (terminator: string, what: string): number => {
    const end = source.indexOf(terminator, position);
    if (end === -1) throw new XmlParseError(`Unterminated ${what}`);
    return end;
  };

  while (position < source.length) {
    const open = source.indexOf('<', position);
    const textEnd = open === -1 ? source.length : open;
    if (textEnd > position) {
      const raw = source.slice(position, textEnd);
      const parent = stack.at(-1);
      if (parent === undefined) {
        if (raw.trim() !== '') throw new XmlParseError('Text outside the root element');
      } else {
        parent.text += decodeXmlText(raw);
      }
      position = textEnd;
      continue;
    }

    if (source.startsWith('<?', position)) {
      position = expectEnd('?>', 'processing instruction') + 2;
    } else if (source.startsWith('<!--', position)) {
      position = expectEnd('-->', 'comment') + 3;
    } else if (source.startsWith('<![CDATA[', position)) {
      const end = expectEnd(']]>', 'CDATA section');
      const parent = stack.at(-1);
      if (parent === undefined) throw new XmlParseError('CDATA outside the root element');
      parent.text += source.slice(position + 9, end);
      position = end + 3;
    } else if (source.startsWith('<!', position)) {
      throw new XmlParseError('DOCTYPE and other declarations are not accepted');
    } else if (source.startsWith('</', position)) {
      const end = expectEnd('>', 'end tag');
      const name = localName(source.slice(position + 2, end).trim());
      const element = stack.pop();
      if (element?.name !== name) {
        throw new XmlParseError(`Mismatched end tag </${name}>`);
      }
      position = end + 1;
    } else {
      // Start tag. Scan to the closing '>' outside quoted attribute values.
      let cursor = position + 1;
      let quote: string | undefined;
      for (; cursor < source.length; cursor += 1) {
        const char = source[cursor];
        if (quote !== undefined) {
          if (char === quote) quote = undefined;
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (char === '>') {
          break;
        }
      }
      if (cursor >= source.length) throw new XmlParseError('Unterminated start tag');
      const selfClosing = source[cursor - 1] === '/';
      const inner = source.slice(position + 1, selfClosing ? cursor - 1 : cursor);
      const nameMatch = /^[^\s/>]+/.exec(inner);
      if (nameMatch === null) throw new XmlParseError('Start tag without a name');
      const element: XmlElement = { name: localName(nameMatch[0]), children: [], text: '' };
      const parent = stack.at(-1);
      if (parent === undefined) {
        if (root !== undefined) throw new XmlParseError('More than one root element');
        root = element;
      } else {
        parent.children.push(element);
      }
      if (!selfClosing) stack.push(element);
      position = cursor + 1;
    }
  }

  if (stack.length > 0) throw new XmlParseError(`Unclosed element <${stack.at(-1)?.name}>`);
  if (root === undefined) throw new XmlParseError('No root element');
  return root;
}

/** The first child element called `name`, or `undefined`. */
export function childElement(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}

/** The text of the first child element called `name`, or `undefined`. */
export function childText(element: XmlElement, name: string): string | undefined {
  return childElement(element, name)?.text;
}
