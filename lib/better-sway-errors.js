const chalk = require('chalk');

module.exports = function(errors, isWarning = false) {
  let message = '';
  const filteredErrors = errors.filter(error => error.code !== 'UNUSED_DEFINITION');
  filteredErrors.forEach((error, i) => {
    const paths = error.path.map(path => {
      if (path.startsWith('/')) {
        return `[${chalk.green(`'${path}'`)}]`;
      }
      return chalk.blue(path);
    });
    const pathToError = paths.length ? `${chalk.bold(paths.join('/'))}: ` : '';
    message += `\n${i + 1}) ${pathToError}${chalk[isWarning ? 'yellow' : 'red'](error.message)}`;
    if (error.inner) {
      message += findInnerErrors(error, isWarning);
    }
  });
  return message;
};

function findInnerErrors(error, isWarning, spaces = 3) {
  const messages = [];
  error.inner.forEach(e => {
    messages.push(`\n${' '.repeat(spaces)}${chalk[isWarning ? 'yellow' : 'red'](e.message)}`);
    if (e.inner) {
      messages.push(findInnerErrors(e, isWarning, spaces + 2));
    }
  });

  return messages.filter((msg, i) => messages.indexOf(msg) === i).join('');
}
