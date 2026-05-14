/**
 * Legacy reference: QuizMorph now creates forms via the Google Forms API using each user’s OAuth
 * refresh token (see apps/api GoogleFormsService). You can still deploy this as a Web App for experiments.
 * Set script property QUIZMORPH_SECRET to match APPS_SCRIPT_SHARED_SECRET if you use it.
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var expected = PropertiesService.getScriptProperties().getProperty('QUIZMORPH_SECRET');
    if (!expected || body.secret !== expected) {
      return jsonResponse_({ ok: false, error: 'Unauthorized' });
    }

    var form = FormApp.create(body.title);
    form.setRequireLogin(false);
    form.setIsQuiz(true);

    var questions = body.questions.slice().sort(function (a, b) {
      return a.order - b.order;
    });

    for (var i = 0; i < questions.length; i++) {
      var q = questions[i];
      if (q.type === 'MULTIPLE_CHOICE' || q.type === 'TRUE_FALSE') {
        var opts = q.options && q.options.length ? q.options : ['A', 'B', 'C', 'D'];
        var item = form.addMultipleChoiceItem();
        item.setTitle(q.title);
        item.setPoints(1);
        var correctIdx =
          q.correctOptionIndex !== null && q.correctOptionIndex !== undefined
            ? q.correctOptionIndex
            : 0;
        if (correctIdx < 0 || correctIdx >= opts.length) correctIdx = 0;
        var choices = [];
        for (var j = 0; j < opts.length; j++) {
          choices.push(item.createChoice(opts[j], j === correctIdx));
        }
        item.setChoices(choices);
      } else if (q.type === 'SHORT_ANSWER') {
        var shortItem = form.addTextItem();
        shortItem.setTitle(q.title);
        shortItem.setPoints(1);
      } else {
        var pItem = form.addParagraphTextItem();
        pItem.setTitle(q.title);
        pItem.setPoints(1);
      }
    }

    return jsonResponse_({
      ok: true,
      formId: form.getId(),
      formUrl: form.getPublishedUrl(),
      editUrl: form.getEditUrl(),
    });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err) });
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
