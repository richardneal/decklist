/* exported Decklist */
/* global $, cards */

// Accepts optional parameters for maindeck and sideboard input
// If not passed--except when testing, this should be the case--form fields are read for these values
// Returns the following object:
// {
//   main: [ {...card, q: quantity}, ... ],
//   side: [ {...card, q: quantity}, ... ],
//   unrecognized: [ cardName, ... ],
//   unparseable: [ string, ... ]
// }
var Decklist = {
  parse: function(deckmain, deckside) {
    deckmain = deckmain || $('#deckmain').val(), deckmain = deckmain.split('\n'),
    deckside = deckside || $('#deckside').val(), deckside = deckside.split('\n');
    const cardRE = [
      /^\s*(\d+)\s+\[.*\]\s+(.+?)\s*$/,      // MWS, what an ugly format
      /^\s*(\d+)x*\s(.+?)\s*$/,              // MTGO deck format (4 Brainstorm) also TCG (4x Brainstorm)
      /^\s*()?(.+?)\s*$/,                    // Single card
    ];
    // MWS and others mark each sideboard line instead: SB: 2 Blood Moon
    const sbRE = /^\s*SB:\s*/i;
    // MWS and Scryfall write comment lines: // Deck file for Magic Workstation
    const commentRE = /^\s*\/\//;
    // The printing Arena and Moxfield follow a name with: (2X2) 117, (MH2) 290 *F*
    const printingRE = /(?:\s+\([a-z0-9]{2,8}\)(?:\s+[^\s()*]+)?)?(?:\s+\*[a-z]+\*)*$/i;
    // Section headers, as Arena, MTGO and Moxfield export them: Deck, Sideboard:,
    // Commander (1). About starts a block that names the deck, skipped to the next blank
    // line, and cards under Maybeboard are left out, as the deck import leaves them
    const headerRE = /^\s*([a-z]+(?: [a-z]+)?)\s*(?:\(\d+\))?\s*:?\s*$/i,
      sections = {
        deck: 'main', main: 'main', mainboard: 'main', maindeck: 'main',
        sideboard: 'side', sb: 'side',
        commander: 'commander', commanders: 'commander',
        companion: 'companion', companions: 'companion',
        maybeboard: 'maybe',
        about: 'about',
      };

    // Get cards from maindeck and sideboard inputs
    const scans = [scan(deckmain, 'main'), scan(deckside, 'side')];

    // Commanders lead the sideboard, then a companion, as the deck import places them.
    // Arena lists its companion again in the sideboard proper; that is the same card
    const leaders = gather('commander', 'companion'),
      sideboard = gather('side').filter(function(card) {
        const leader = leaders.find(function(leader) { return leader['n'] === card['n']; });
        if (leader) {
          leader['q'] = Math.max(leader['q'], card['q']);
        }
        return !leader;
      });

    return {
      main: gather('main'),
      side: leaders.concat(sideboard),
      // de-duplicate unrecognized card names
      unrecognized: gather('unrecognized').filter(onlyUnique),
      unparseable: gather('unparseable'),
    };

    // helper functions

    // Collects one or more of the scans' lists into one, in order: each key from
    // the maindeck input and then the sideboard input
    // Accepts the keys of the lists to collect (see scan())
    // Returns a single list, with duplicate cards merged by list_add()
    function gather(...keys) {
      var list = [];
      keys.forEach(function(key) {
        scans.forEach(function(scanned) {
          scanned[key].forEach(function(card) {
            list_add(list, card);
          });
        });
      });
      return list;
    }

    // Finds the section a header line starts
    // Accepts an input string
    // Returns 'main', 'side', 'commander', 'companion', 'maybe' or 'about', or null for any other line
    function headerOf(line) {
      // any line starting with Sideboard has always switched to it
      if (/^\s*side ?board\b/i.test(line)) {
        return 'side';
      }
      let match = headerRE.exec(line),
        word = match && match[1].toLowerCase().replace(' ', '');
      return word && sections.hasOwnProperty(word) ? sections[word] : null;
    }

    // Scans lines of a given array for cards
    // Accepts an array of input strings and the section its cards go to until a header
    // says otherwise ('main' or 'side'). A blank line after main deck cards starts the
    // sideboard, unless a header follows it. Comment lines and the maybeboard are skipped
    // Returns an object structured like parse()'s result, with the cards listed under
    // Commander and Companion headers in lists of their own
    function scan(lines, section) {
      var identified = {
          main: [],
          side: [],
          commander: [],
          companion: [],
          unrecognized: [],
          unparseable: [],
        },
        emptyLine = /^\s*$/,
        in_sb = false,
        in_about = false,
        hasMainCards = false;

      // main parsing loop
      linesLoop: for (var i = 0; i < lines.length; i++) {
        var line = lines[i],
          header = headerOf(line);

        // a comment changes nothing, not even a pending switch to the sideboard
        if (commentRE.test(line)) {
          continue;
        }
        // an empty line after main cards switches to the sideboard, once a card follows
        if (emptyLine.test(line)) {
          in_sb = in_sb || (section === 'main' && hasMainCards);
          in_about = false;
          continue;
        }
        if (header) {
          in_about = header === 'about';
          section = in_about ? section : header;
          in_sb = false;
          continue;
        }
        if (in_about || section === 'maybe') {
          continue;
        }
        if (in_sb) {
          section = 'side';
          in_sb = false;
        }

        let list = section,
          sb = sbRE.exec(line);
        if (sb) {
          line = line.slice(sb[0].length);
          list = 'side';
        }

        // check lines against the card regexes
        for (var j = 0; j < cardRE.length; j++) {
          let re = cardRE[j];
          if (!re.test(line)) {
            continue;
          }

          let result = re.exec(line),
            quantity = parseInt(result[1]) || 1,
            cardName = result[2];
          // drop a trailing printing, unless it is part of the name (Hazmat Suit (Used))
          if (!cards.hasOwnProperty(cardName.toLowerCase())) {
            cardName = cardName.replace(printingRE, '');
          }
          let card = getCard(cardName);
          // add quantity field to card object
          if (card) {
            card['q'] = quantity;
          } else {
            // card is not recognized; create a dummy card object
            var encodedCardName = htmlEncode(cardName);
            card = {
              'n': encodedCardName,
              'q': quantity,
            };
            // add card name to unrecognized array only if it is not already present
            if (identified['unrecognized'].indexOf(encodedCardName) === -1) {
              identified['unrecognized'].push(encodedCardName);
            }
          }
          // Mark that we have encountered main deck cards
          if (list === 'main') {
            hasMainCards = true;
          }
          // add card to identified list
          identified[list] = list_add(identified[list], card);
          continue linesLoop;
        }
        // this statement will only be reached if no passed regexes match the current line
        // add to unparseable list if it is not only whitespace
        if (line.trim()) {
          identified['unparseable'].push(htmlEncode(line));
        }
      }
      return identified;

      // Returns an HTML-safe string (to avoid XSS)
      // Accepts a string
      // Returns a string with HTML-unsafe entities escaped
      function htmlEncode(string) {
        return string.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      // Finds the card object from the global cards object
      // Accepts a card name string
      // Returns the card's object if found, or null if not found
      function getCard(name) {
        // Convert the name to lowercase
        name = name.toLowerCase();
    
        // Replace alternative separators for dual cards
        name = name.replace(/\s*\/+\s*/g, " // ");
    
        // First, try to find the card with the original name
        if (cards.hasOwnProperty(name)) {
            return cards[name];
        }
    
        // Function to perform normalization and replacement
        function normalizeCardName(cardName) {
            // Normalize by removing accents
            cardName = cardName.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    
            // Replace specific characters (e.g., æ)
            return cardName.replace('\u00e6', 'ae');
            // Add more replacements if needed
        }
    
        // If not found, normalize the name and try again
        let normalized_name = normalizeCardName(name);
        if (cards.hasOwnProperty(normalized_name)) {
            return cards[normalized_name];
        }

        // Next, ignore split-card slashes, so "Fire Ice" finds Fire // Ice
        let loose = Decklist.searchIndex().get(Decklist.searchKey(name));
        if (loose) {
          return loose;
        }

        // Last, a double-faced, adventure, flip or prepare card spelled out in
        // full, as deck sites export it, is stored under its front face alone
        let front = name.split(' // ')[0];
        return front !== name ? getCard(front) : null;
      }
    
    }
    // Adds a card object to a given deck list (new addition or updates an already-present quantity)
    // Accepts a deck list (array of card objects) and a card object
    // Returns the deck after adding the card or updating the quantity of the already-present card
    // Alternatively, if newCard is a string, simply adds the string to the deck list (used for identified['unrecognized'] and identified['unparseable'])
    function list_add(list, newCard) {
      if (typeof newCard === 'string') {
        return list.push(newCard);
      }
      var cardName = newCard['n'],
        cardIndex = listContainsCard(list, cardName);
      if (cardIndex !== -1) {
        list[cardIndex]['q'] += newCard['q'];
      } else {
        // deep clone object when adding to list to avoid pointer issues when
        // incrementing its size if it is duplicated
        list.push(Object.assign({}, newCard));
      }
      return list;

      // Finds the index of a card name within the given deck list
      // Accepts a deck list (array of card objects) and a card name string
      // Returns the index of the card, if found, or -1 otherwise
      function listContainsCard(list, cardName) {
        for (var i = 0; i < list.length; i++) {
          if (list[i]['n'] === cardName) {
            return i;
          }
        }
        return -1;
      }
    }
    // A uniqueness filtering function for use in array.filter()
    // Returns true only for unique values (the first value found for any duplicates)
    function onlyUnique(value, index, self) {
      return self.indexOf(value) === index;
    }
  },

  // Sorts a given deck list
  // Accepts a deck list (array of card objects) and an optional sort order
  // If no order is passed, it is read from the sort order input on the page
  // Returns the deck list after being sorted via the given order
  sort: function(deck, sortorder) {
    let formsortorder = $('#decksort').val();
    // to allow the function to be mappable, we force non-string "sortorder" values to default to user-entered sort order
    sortorder = typeof sortorder === 'string' ? sortorder || formsortorder : formsortorder;

    if (sortorder === 'original') {
      return deck;
    } else if (sortorder === 'alphabetical') {
      deck.sort(alphabeticalCardSort);
    } else if (sortorder === 'manavalue') {
      deck.sort(manaValueCardSort);
    } else if (sortorder === 'color') {
      deck.sort(colorCardSort);
    } else if (sortorder === 'numeric') {
      deck.sort(numericCardSort);
    } else if (sortorder === 'type') {
      deck.sort(typeCardSort);
    } else {
      // TODO: move to notifications
      console.error('Unrecognized sort order passed: ' + sortorder + ', no deck sorting will be performed.');
    }
    return deck;

    // sort functions

    // sort cards alphabetically
    function alphabeticalCardSort(a, b) {
      var cardA = a['n'].toLowerCase(),
        cardB = b['n'].toLowerCase();
      if (cardA > cardB) {
        return 1;
      } else if (cardA < cardB) {
        return -1;
      }
      return 0;
    }
    // sort by mana value, then alphabetically
    function manaValueCardSort(a, b) {
      return Decklist.manaValueGroup(a) - Decklist.manaValueGroup(b) || alphabeticalCardSort(a, b);
    }
    // sort by color of cards, then alphabetically
    function colorCardSort(a, b) {
      var colorA = a['c'] || 'X',
        colorB = b['c'] || 'X';
      if (colorA > colorB) {
        return 1;
      } else if (colorA < colorB) {
        return -1;
      } else {
        return alphabeticalCardSort(a, b);
      }
    }
    // sort by quantity of cards, then alphabetically
    function numericCardSort(a, b) {
      var numA = a['q'],
        numB = b['q'];
      if (numA > numB) {
        return 1;
      } else if (numA < numB) {
        return -1;
      } else {
        return alphabeticalCardSort(a, b);
      }
    }
    // sort by type, then alphabetically
    function typeCardSort(a, b) {
      var typeA = a['t'] || '9',
        typeB = b['t'] || '9';
      if (typeA > typeB) {
        return 1;
      } else if (typeA < typeB) {
        return -1;
      } else {
        return alphabeticalCardSort(a, b);
      }
    }
  },

  // Add spacers between decklist sections
  // Accepts a (presumably sorted) decklist (array of card objects) and an optional section type to separate sections by
  // If no section type is passed, it is read from the sort order input on the page
  // Returns a decklist that contains the argument's cards with separators between sections as defined by sectionType
  section: function(deck, sectionType) {
    let formSectionType = $('#decksort').val();
    // to allow the function to be mappable, we force non-string "sectionType" values to default to user-entered sort order
    sectionType = typeof sectionType === 'string' ? sectionType || formSectionType : formSectionType;

    if (sectionType === 'manavalue') {
      return addSections(deck, Decklist.manaValueGroup);
    } else if (sectionType ==='color') {
      return addSections(deck, function(card) { return card['c']; });
    } else if (sectionType === 'type') {
      return addSections(deck, function(card) { return card['t']; });
    } else {
      // no-op
      return deck;
    }

    // Adds spacers based on delimiters
    // See section(), except delimiter is a function returning the card's section (eg. its 'c' property) and is not optional
    function addSections(list, delimiter) {
      var numAdded = 0,
        listLength = list.length;
      for (var i = 1; i < listLength; i++) {
        var index = i + numAdded,
          emptyCard = { n: '', q: 0 };
        if (delimiter(list[index]) !== delimiter(list[index - 1])) {
          list.splice(index, 0, emptyCard);
          numAdded++;
        }
      }
      return list;
    }
  },

  // Accepts a card object
  // Returns the group it sorts and sections under by mana value: its mana value for spells,
  // then 99 for lands (whose mana value is 0) and 100 for unrecognized cards
  manaValueGroup: function(card) {
    if (card['t'] === '1') {
      return 99;
    }
    return typeof card['m'] === 'number' ? card['m'] : 100;
  },

  // Accepts a deck list (array of card objects)
  // Returns a count of number of cards in a given deck
  // Loose form of a card name for matching what people type: case, accents and
  // split-card slashes are ignored, so "fire ice" and "Fire // Ice" agree
  searchKey: function(name) {
    return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/æ/g, 'ae').replace(/\//g, ' ').replace(/\s+/g, ' ').trim();
  },

  // Map of searchKey to card object for every card, built on first use
  searchIndex: function() {
    if (!Decklist._searchIndex) {
      Decklist._searchIndex = new Map();
      for (const key in cards) {
        Decklist._searchIndex.set(Decklist.searchKey(cards[key].n), cards[key]);
      }
    }
    return Decklist._searchIndex;
  },

  count: function(deck) {
    var count = 0;
    Object.values(deck).forEach(function(card) {
      count += card['q'];
    });
    return count;
  },

  // Filters a deck by a given field for some set of allowed values
  // Accepts a deck list (array of card objects), a card field, an allowed value
  // or array of allowed values, and an optional mode--"include" or "exclude" (default is "include")
  // Returns the filtered deck list, only including (or excluding) the given field values
  filter: function(deck, field, values, mode = 'include') {
    if (!Array.isArray(values)) {
      values = [values];
    }
    return deck.filter(function(card) {
      let include = false;
      if (card.hasOwnProperty(field) && values.includes(card[field])) {
        include = true;
      }
      if (mode === 'exclude') {
        include = !include;
      }
      return include;
    });
  },

  // The formats a deck can be checked against. code is the letter the card data's
  // b (not legal) and r (restricted) fields write the format as; Other constructed
  // and Limited have no card pool to check. A Pauper Commander deck's commander is a
  // creature printed at uncommon, which the card data doesn't record, so its
  // commander's legality goes unchecked (uncheckedCommander)
  formats: {
    standard:        { name: 'Standard',          rules: 'constructed', code: 's' },
    pioneer:         { name: 'Pioneer',           rules: 'constructed', code: 'p' },
    modern:          { name: 'Modern',            rules: 'constructed', code: 'm' },
    legacy:          { name: 'Legacy',            rules: 'constructed', code: 'l' },
    vintage:         { name: 'Vintage',           rules: 'constructed', code: 'v' },
    pauper:          { name: 'Pauper',            rules: 'constructed', code: 'u' },
    premodern:       { name: 'Premodern',         rules: 'constructed', code: 'e' },
    oldschool:       { name: 'Old School',        rules: 'constructed', code: 'o' },
    commander:       { name: 'Commander',         rules: 'commander',   code: 'c' },
    duel:            { name: 'Duel Commander',    rules: 'commander',   code: 'd' },
    paupercommander: { name: 'Pauper Commander',  rules: 'commander',   code: 'a', uncheckedCommander: true },
    predh:           { name: 'PreDH',             rules: 'commander',   code: 'h' },
    oathbreaker:     { name: 'Oathbreaker',       rules: 'oathbreaker', code: 't' },
    constructed:     { name: 'Other constructed', rules: 'constructed' },
    limited:         { name: 'Limited',           rules: 'limited' }
  },

  // Whether a format's deck is led by cards listed in the sideboard (a commander, or an
  // Oathbreaker and its signature spell), and holds one copy of each card
  // Accepts a key of Decklist.formats
  isSingleton: function(format) {
    const rules = (Decklist.formats[format] || Decklist.formats.constructed).rules;
    return rules === 'commander' || rules === 'oathbreaker';
  },

  // Guesses a parsed deck's format. Commander and Limited decks show by their shape:
  // a Commander deck keeps 99 or so cards in the main deck and only its commanders and
  // a companion in the sideboard, and a Limited deck runs 40 cards, or a few more, which
  // no constructed deck may. Any other deck gets the narrowest format it passes the
  // checks for, so a guess never reports a card as illegal; only a chosen format can
  // Accepts a parse() result
  // Returns a key of Decklist.formats
  detectFormat: function(deck) {
    const main = Decklist.count(deck.main);
    if (main >= 90 && Decklist.count(deck.side) <= 3) {
      return 'commander';
    }
    if (main >= 40 && main <= 45) {
      return 'limited';
    }
    if (!deck.main.length && !deck.side.length) {
      return 'constructed';
    }
    const narrowest = ['standard', 'pioneer', 'pauper', 'modern', 'legacy', 'vintage'].find(function(format) {
      const problems = Decklist.check(deck, format).deckmain;
      return !problems.some(function(problem) { return problem['error'] === 'illegal' || problem['error'] === 'restricted'; });
    });
    return narrowest || 'constructed';
  },

  // Accepts one of the copies a 'quantity' check reports ({n, q, limit})
  // Returns how far over its limit it is: "5 copies; limit 4"
  copiesNote: function(card) {
    return card['q'] + ' copies; limit ' + card['limit'];
  },

  // Checks a parsed deck against the rules of a format
  // Accepts a parse() result and a key of Decklist.formats
  // Returns {deckmain: [...], deckside: [...]}, each a list of validation objects
  // ({error: type} or {warning: type}, with data where the message needs it). The
  // card checks name their cards in data.cards; 'quantity' also lists data.copies
  check: function(deck, format) {
    const definition = Decklist.formats[format] || Decklist.formats.constructed,
      main = Decklist.count(deck.main),
      side = Decklist.count(deck.side),
      result = { deckmain: [], deckside: [] };

    if (definition.rules === 'commander') {
      // 100 cards, commanders included; a companion starts outside the game, so a
      // sideboard of two or more may hold one beyond the 100
      if (main + side < 100) {
        result.deckmain.push({ error: 'commandertoosmall', data: { count: main + side, format: definition.name } });
      } else if (main + side > (side >= 2 ? 101 : 100)) {
        result.deckmain.push({ error: 'commandertoolarge', data: { count: main + side, format: definition.name } });
      }
      if (side === 0)    { result.deckside.push({ warning: 'nocommander' });   }
      else if (side > 3) { result.deckside.push({ warning: 'commanderside' }); }
    } else if (definition.rules === 'oathbreaker') {
      // 60 cards, counting the Oathbreaker and its signature spell, which take the
      // sideboard's place
      if (main + side !== 60) { result.deckmain.push({ error: 'oathbreakersize', data: main + side }); }
      if (side < 2)      { result.deckside.push({ warning: 'nooathbreaker' });   }
      else if (side > 2) { result.deckside.push({ warning: 'oathbreakerside' }); }
    } else if (definition.rules === 'limited') {
      if (main < 40) { result.deckmain.push({ error: 'toosmall', data: { min: 40, count: main } }); }
      return result;
    } else {
      if ((main === 0) || (main > 60)) { result.deckmain.push({ warning: 'size', data: main });                     }
      else if (main < 60)              { result.deckmain.push({ error: 'toosmall', data: { min: 60, count: main } }); }
      if (side > 15) { result.deckside.push({ error: 'toolarge', data: side });   }
      if (side < 15) { result.deckside.push({ warning: 'toosmall', data: side }); }
    }

    // copies across the main deck and sideboard: a card's own text (x) beats the
    // format's limit, and a card restricted in a constructed format is limited to one.
    // A Commander variant holds every card to one already, and restricts the cards
    // that may not be the commander
    const singleton = Decklist.isSingleton(format),
      inFormat = function(card, field) { return Boolean(definition.code) && (card[field] || '').includes(definition.code); },
      mainNames = new Set(deck.main.map(function(card) { return card['n']; })),
      sideNames = new Set(deck.side.map(function(card) { return card['n']; })),
      totals = new Map(), excess = [], restricted = [], illegal = [], notCommander = [];
    deck.main.concat(deck.side).forEach(function(card) {
      const total = totals.get(card['n']);
      if (total) { total['q'] += card['q']; } else { totals.set(card['n'], Object.assign({}, card)); }
    });
    totals.forEach(function(card) {
      const isRestricted = !singleton && inFormat(card, 'r'),
        limit = 'x' in card ? (card['x'] || Infinity) : (singleton || isRestricted) ? 1 : 4;
      if (card['q'] > limit) {
        if (isRestricted && !('x' in card)) {
          restricted.push(card['n']);
        } else {
          excess.push({ n: card['n'], q: card['q'], limit: limit });
        }
      }
      // a card only in the sideboard is the commander or a companion
      const uncheckedCommander = definition.uncheckedCommander && !mainNames.has(card['n']);
      if (inFormat(card, 'b') && !uncheckedCommander) {
        illegal.push(card['n']);
      }
      if (definition.rules === 'commander' && inFormat(card, 'r') && sideNames.has(card['n'])) {
        notCommander.push(card['n']);
      }
    });
    if (excess.length) {
      result.deckmain.push({ error: 'quantity', data: {
        cards: excess.map(function(card) { return card['n'] + ' (' + Decklist.copiesNote(card) + ')'; }),
        copies: excess
      } });
    }
    if (restricted.length)   { result.deckmain.push({ error: 'restricted', data: { cards: restricted, format: definition.name } }); }
    if (illegal.length)      { result.deckmain.push({ error: 'illegal', data: { cards: illegal, format: definition.name } }); }
    if (notCommander.length) { result.deckside.push({ error: 'notcommander', data: { cards: notCommander, format: definition.name } }); }
    return result;
  }
}
