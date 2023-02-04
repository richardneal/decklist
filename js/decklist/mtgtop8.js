/* exported MTGTop8 */

var MTGTop8 = {
    pattern: new URLPattern('https://www.mtgtop8.com/event?*'),
    corsURL: 'https://crimson-snowflake-9022.fly.dev/',
    decklistURL: 'https://www.mtgtop8.com/mtgo?d=',
    isTop8: function(url) {
        return this.pattern.test(url);
    },
    getDecklist: function(url) {
        searchParams = new URLSearchParams(url);
        id = searchParams.get('d');
        $.ajax({
            url: this.corsURL + this.decklistURL + id,
            headers: {
                'X-Requested-With': '*'
            },
            method: 'GET',
            dataType: 'text',
            success: function(result){
                split = result.split('\r\nSideboard\r\n');
                $("#deckmain").html(split[0]);
                $("#deckside").html(split[1]);
            }
          });
    }
  };