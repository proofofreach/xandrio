const CARDINAL_SMALL = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen'
];
const ORDINAL_SMALL = [
  'zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh',
  'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth',
  'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth'
];
const CARDINAL_TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'
];
const ORDINAL_TENS = [
  '', '', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth',
  'sixtieth', 'seventieth', 'eightieth', 'ninetieth'
];
const CARDINAL_SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];
const ORDINAL_SCALES = ['', 'thousandth', 'millionth', 'billionth', 'trillionth'];
const CURRENCY_NAMES = {
  '$': { major: 'dollar', majorPlural: 'dollars', minor: 'cent', minorPlural: 'cents' },
  '£': { major: 'pound', majorPlural: 'pounds', minor: 'penny', minorPlural: 'pence' },
  '€': { major: 'euro', majorPlural: 'euros', minor: 'cent', minorPlural: 'cents' },
  '¥': { major: 'yen', majorPlural: 'yen' }
};

function cardinalUnderThousand(value) {
  if (value < 20) return CARDINAL_SMALL[value];
  if (value < 100) {
    const remainder = value % 10;
    return CARDINAL_TENS[Math.floor(value / 10)] +
      (remainder ? `-${CARDINAL_SMALL[remainder]}` : '');
  }
  const remainder = value % 100;
  return `${CARDINAL_SMALL[Math.floor(value / 100)]} hundred` +
    (remainder ? ` ${cardinalUnderThousand(remainder)}` : '');
}

function ordinalUnderThousand(value) {
  if (value < 20) return ORDINAL_SMALL[value];
  if (value < 100) {
    const remainder = value % 10;
    return remainder
      ? `${CARDINAL_TENS[Math.floor(value / 10)]}-${ORDINAL_SMALL[remainder]}`
      : ORDINAL_TENS[Math.floor(value / 10)];
  }
  const remainder = value % 100;
  return `${CARDINAL_SMALL[Math.floor(value / 100)]} hundred` +
    (remainder ? ` ${ordinalUnderThousand(remainder)}` : 'th');
}

function groupsFor(value) {
  const groups = [];
  let remaining = value;
  do {
    groups.push(Number(remaining % 1000n));
    remaining /= 1000n;
  } while (remaining > 0n);
  return groups;
}

function integerToCardinalWords(input) {
  const value = typeof input === 'bigint'
    ? input
    : BigInt(String(input).replace(/,/g, ''));
  if (value < 0n) return `minus ${integerToCardinalWords(-value)}`;
  if (value === 0n) return CARDINAL_SMALL[0];

  const groups = groupsFor(value);
  if (groups.length > CARDINAL_SCALES.length) return null;
  const words = [];
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    if (!group) continue;
    words.push(`${cardinalUnderThousand(group)}${index ? ` ${CARDINAL_SCALES[index]}` : ''}`);
  }
  return words.join(' ');
}

function integerToOrdinalWords(input) {
  const value = typeof input === 'bigint'
    ? input
    : BigInt(String(input).replace(/,/g, ''));
  if (value < 0n) return null;

  const groups = groupsFor(value);
  if (groups.length > CARDINAL_SCALES.length) return null;
  const lowestNonZeroGroup = groups.findIndex(group => group !== 0);
  if (lowestNonZeroGroup === -1) return ORDINAL_SMALL[0];

  const words = [];
  for (let index = groups.length - 1; index >= lowestNonZeroGroup; index--) {
    const group = groups[index];
    if (!group) continue;
    if (index === lowestNonZeroGroup) {
      words.push(index === 0
        ? ordinalUnderThousand(group)
        : `${cardinalUnderThousand(group)} ${ORDINAL_SCALES[index]}`);
    } else {
      words.push(`${cardinalUnderThousand(group)} ${CARDINAL_SCALES[index]}`);
    }
  }
  return words.join(' ');
}

function expectedOrdinalSuffix(value) {
  const lastTwo = Number(value % 100n);
  if (lastTwo >= 11 && lastTwo <= 13) return 'th';
  return ({ 1: 'st', 2: 'nd', 3: 'rd' })[Number(value % 10n)] || 'th';
}

function numericOrdinalToWords(digits, suffix) {
  const value = BigInt(String(digits).replace(/,/g, ''));
  if (expectedOrdinalSuffix(value) !== String(suffix).toLowerCase()) return null;
  return integerToOrdinalWords(value);
}

function currencyAmountToWords(symbol, amount) {
  const names = CURRENCY_NAMES[symbol];
  const match = String(amount || '').match(/^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/);
  if (!names || !match || (!names.minor && match[2])) return null;

  const majorValue = BigInt(match[1].replace(/,/g, ''));
  const minorValue = match[2] ? BigInt(match[2].padEnd(2, '0')) : 0n;
  const majorWords = integerToCardinalWords(majorValue);
  const minorWords = integerToCardinalWords(minorValue);
  if (!majorWords || !minorWords) return null;

  const parts = [];
  if (majorValue !== 0n || minorValue === 0n) {
    parts.push(`${majorWords} ${majorValue === 1n ? names.major : names.majorPlural}`);
  }
  if (minorValue !== 0n) {
    parts.push(`${minorWords} ${minorValue === 1n ? names.minor : names.minorPlural}`);
  }
  return parts.join(' and ');
}

function yearToWords(input) {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1000 || value > 2099) {
    return integerToCardinalWords(input);
  }
  if (value >= 1100 && value <= 1999) {
    const century = Math.floor(value / 100);
    const remainder = value % 100;
    if (remainder === 0) return `${integerToCardinalWords(century)} hundred`;
    if (remainder < 10) return `${integerToCardinalWords(century)} oh ${integerToCardinalWords(remainder)}`;
    return `${integerToCardinalWords(century)} ${integerToCardinalWords(remainder)}`;
  }
  if (value >= 2000 && value <= 2009) return integerToCardinalWords(value);
  if (value >= 2010) return `twenty ${integerToCardinalWords(value % 100)}`;
  return integerToCardinalWords(value);
}

function romanToInteger(value) {
  const roman = String(value || '').toUpperCase();
  if (!/^(?:M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))$/.test(roman) || !roman) {
    return null;
  }
  const numerals = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let index = 0; index < roman.length; index++) {
    const current = numerals[roman[index]];
    const next = numerals[roman[index + 1]] || 0;
    total += current < next ? -current : current;
  }
  return total;
}

function romanProvisionToWords(value) {
  const match = String(value || '').toUpperCase().match(/^([IVXLCDM]+)([A-Z])?$/);
  if (!match) return null;
  const number = romanToInteger(match[1]);
  if (number === null) return null;
  return `${integerToCardinalWords(number)}${match[2] ? ` ${match[2]}` : ''}`;
}

module.exports = {
  integerToCardinalWords,
  integerToOrdinalWords,
  numericOrdinalToWords,
  currencyAmountToWords,
  yearToWords,
  romanToInteger,
  romanProvisionToWords
};
