/* exported MTGGoldfish */

var MTGGoldfish = {
    pattern: new URLPattern('https://www.mtggoldfish.com/deck/:id#*'),
    corsURL: 'https://crimson-snowflake-9022.fly.dev/',
    decklistURL: 'https://www.mtggoldfish.com/deck/download/',
    isGoldfish: function(url) {
        return this.pattern.test(url);
    },
    getDecklist: function(url) {
        id = this.pattern.exec(url).pathname.groups.id;
        $.ajax({
            url: this.corsURL + this.decklistURL + id,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type':'text/plain'
            },
            method: 'GET',
            dataType: 'text',
            success: function(result){
                split = result.split('\r\n\r\n');
                $("#deckmain").html(split[0]);
                $("#deckside").html(split[1]);
            }
          });
    }
  };