/*******************************************************************************
 * BBLog.gs - (A better BetterLog)
 *********************************
 *
 * Google Apps Script logging library 
 *
 * - Multi-instance logs
 * - Log to Firebase or GSheets
 * - Automatically log the calling function name
 * - Automatically log the user's email address or ID, in a full or disguised
 *   format
 * 
 * It is based on BetterLog:
 *
 *   https://sites.google.com/site/scriptsexamples/custom-methods/betterlog
 */

/*******************************************************************************
 * Copyright (c) 2018 Andrew Roberts
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *   http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


/********************************************************************************
 * Public Properties
 *******************/

// http://docs.oracle.com/javase/7/docs/api/java/util/logging/Level.html
// For a log to be displayed it's level need to be higher than
// minLevelToDisplay

var Level = Object.freeze({
  OFF     : {name: 'OFF',     value: Number.MAX_VALUE},
  SEVERE  : {name: 'SEVERE',  value: 1000},            
  WARNING : {name: 'WARNING', value: 900},             
  INFO    : {name: 'INFO',    value: 800},       
  CONFIG  : {name: 'CONFIG',  value: 700},             
  FINE    : {name: 'FINE',    value: 500},             
  FINER   : {name: 'FINER',   value: 400},             
  FINEST  : {name: 'FINEST',  value: 300},             
  ALL     : {name: 'ALL',     value: Number.MIN_VALUE},
});

// Enum for whether or not to output the calling function's name
//
// !!!! NOTE !!!!: As this library uses exceptions to get the function names, 
// the displaying function names feature has to be disabled for the 
// script editor debugger to work.

var DisplayFunctionNames = Object.freeze({
  YES : true,
  NO  : false
});

// Enum for Outputting a user id

var DisplayUserId = Object.freeze({
  USER_KEY_HIDE : 'USER_KEY_HIDE', // Display the last few chars of active user key
  USER_KEY_FULL : 'USER_KEY_FULL', // Display the full active user key
  EMAIL_HIDE    : 'EMAIL_HIDE',    // Display truncated active user email
  EMAIL_FULL    : 'EMAIL_FULL',    // Display the full active user email
  NONE          : 'NONE',          // Do not display user ID 
});

/********************************************************************************
 * Private Properties/Config
 ***************************/

// Non user-configurable values
var SHEET_LOG_CELL_WIDTH_ = 1200;
var SHEET_LOG_HEADER_     = 'Message layout: "DateTime UTC-Offset MillisecondsSinceInvoked UserID LogLevel Message". Use Ctrl↓ (or Command↓) to jump to the last row';
var DATE_TIME_LAYOUT_     = 'yyyy-MM-dd HH:mm:ss:SSS Z'; //http://docs.oracle.com/javase/6/docs/api/java/text/SimpleDateFormat.html
var JSON_SPACES_          = 0;     // The number of space characters to use as white space
var USER_ID_LENGTH_       = 15;    // Number of chars of user ID to display
var DISABLE_BACKOFF_      = false; // For testing

// User-configurable values (via getLog())
var DEFAULT_LOG_LEVEL_             = Level.INFO.value;
var DEFAULT_LOG_SHEET_NAME_        = 'Log';
var DEFAULT_DISPLAY_FUNCTION_NAME_ = DisplayFunctionNames.NO;
var DEFAULT_DISPLAY_USER_ID_       = DisplayUserId.NONE
var SHEET_MAX_ROWS_                = 50000; // Sheet is cleared and starts again
var ROLLER_ROW_COUNT_              = 100;   // Number of calls after to which to check for max rows

/********************************************************************************
 * Public Methods
 ****************/

function getLog(config) {
  return new BBLog_(config)
}

/**
 * BBlog Constructor
 *
 * The lock service is used when logging to Google Sheet to avoid continuing to 
 * write to the sheet whilst it is rolling over to a new sheet. So although not 
 * essential it makes logging more reliable.
 *
 * All values are optional. So at it's most basic:
 *
 *   var log = BBLog.getLog()
 *   log.info('Test string')
 *
 * @param {object} userConfig
 *   {LockService}                lock                 Lock service                       (Optional, default: null)  
 *   {BBLog.Level}                level                Level of logging to be output      (Optional, default: Level.INFO)
 *   {string}                     sheetId              Log sheet id, null to disable      (Optional, default: Use active spreadsheet)
 *   {string}                     sheetName            Log sheet name                     (Optional, default: 'Log')
 *   {BBLog.DisplayFunctionNames} displayFunctionNames Display calling function names     (Optional, default: DisplayFunctionNames.NO)
 *   {BBLog.DisplayUserId}        displayUserId        Whether a user ID should be output (Optional, default: DisplayUserId.NONE)
 *   {string}                     firebaseUrl          Firebase url                       (Optional, default: null)
 *   {string}                     firebaseSecret       Firebase secret                    (Optional, default: null)
 *   {string}                     useNativeLogger      Use the native Logger service      (Optional, default: false)
 *   {number}                     maxRows              The maximum rows in a log sheet    (Optional, default: 50000)
 *   {number}                     rollerRowCount       Freq' of GSheet roll-over check    (Optional, default: 100)
 *   {boolean}                    hideLog              Whether to hide the log tab        (Optional, default: false)
 *   {string}                     backupFolderId       Where to put old logs              (Optional, default: GDrive root) 
 *   {boolean}                    backupWholeSS        Whether to back the whole ss       (Optional, default: false) 
 *   {boolean}                    useStackdriver       Whether to use StackDriver loggin  (Optional, default: true)  
 *   {boolean}                    skipRepeats          Whether to log repeated errors     (Optional, default: true) // TODO - Not implemented
 */

function BBLog_(userConfig) {

  // All these private properties are initialised here
  this.localSheet           = null;                    // The spreadsheet that log is appended to
  this.localFirebase        = null;                    // The Firebase database used to store logs
  this.userId               = null;                    // A temporary active user key
  this.userEmail            = null;                    // Users email address, displayed as "a...b@domain.com" 
  this.lock                 = null;                    // The lock service object 
  this.minLevelToDisplay                               // Log everything this level or greater.
  this.startTime            = new Date();              // So we can calculate elapsed time
  this.nativeLogger         = false;                   // The Apps Script nativ e logger
  this.displayFunctionNames = DisplayFunctionNames.NO; // Display calling function names?  
  this.useRemoteLogger      = false;                   // Log to web app with urlFetch
  this.maxRows;
  this.rollerRowCount;
  this.backupFolder         = null;
  this.backupWholeSS;
  this.sheetName;

  var defaultConfig_ = {
    lock                 : null,   
    level                : DEFAULT_LOG_LEVEL_,  
    sheetId              : '', // Use active spreadsheet
    sheetName            : DEFAULT_LOG_SHEET_NAME_, 
    displayFunctionNames : DEFAULT_DISPLAY_FUNCTION_NAME_, 
    displayUserId        : DEFAULT_DISPLAY_USER_ID_, 
    firebaseUrl          : null, 
    firebaseSecret       : null, 
    useNativeLogger      : false,
    maxRows              : SHEET_MAX_ROWS_,
    rollerRowCount       : ROLLER_ROW_COUNT_,
    hideLog              : false,
    skipRepeats          : true,
    backupFolderId       : null,
    backupWholeSS        : false,
    useStackdriver       : true,
  }

  // Overwrite defaults with user settings
  if (typeof userConfig === 'object') {
    for (var key in userConfig) {   
      if (userConfig.hasOwnProperty(key)) { 
        if (key === 'level') {
          defaultConfig_[key] = userConfig[key].value
        } else {
          defaultConfig_[key] = userConfig[key]
        }
      }
    }
  }

  if (defaultConfig_.level === Level.OFF.value) {
    this.minLevelToDisplay = Level.OFF.value;
    return;
  }

  this.minLevelToDisplay = defaultConfig_.level;

  if (defaultConfig_.firebaseUrl !== null) {
    
    // Firebase has to come first, so that if it isn't used and 
    // the sheet ID isn't specified the active sheet is used
    
    this.localFirebase = FirebaseApp
      .getDatabaseByUrl(
        defaultConfig_.firebaseUrl,
        defaultConfig_.firebaseSecret);
  } 
  
  if (defaultConfig_.sheetId !== null) {
    
    this.lock = defaultConfig_.lock
    this.maxRows = defaultConfig_.maxRows;
    this.rollerRowCount = defaultConfig_.rollerRowCount;
    
    if (hasAuth()) {
    
      this.localSheet = this._useSpreadsheet(
        defaultConfig_.sheetId, 
        defaultConfig_.sheetName,
        defaultConfig_.hideLog); 
        
      this._rollLogOver(); 
      
    } else {
    
      this.useRemoteLogger = true;
    }
  }
  
  if (defaultConfig_.useNativeLogger) {
    this.nativeLogger = Logger;
  } 
  
  this.displayFunctionNames = defaultConfig_.displayFunctionNames;
  
  var userIdObject = this._storeUserId(defaultConfig_.displayUserId);
  this.userId = userIdObject.userId;
  this.userEmail = userIdObject.userEmail;
  
  this.maxRows = defaultConfig_.maxRows;
  
  var backupFolderId = defaultConfig_.backupFolderId
  if (backupFolderId) {
    try {
      backupFolder = DriveApp.getFolderById(backupFolderId)
    } catch (error) {
      throw new Error('Bad backup log folder ID: ' + backupFolderId + ', Error: ' + error.message)
    }
    if (backupFolder === null) {
      throw new Error('Bad backup log folder ID: ' + backupFolderId)
    } 
    this.backupFolder = backupFolder;
  }
  
  this.backupWholeSS = defaultConfig_.backupWholeSS;
  this.sheetName = defaultConfig_.sheetName;
  this.useStackdriver = defaultConfig_.useStackdriver;
  
  return;
  
  // Private Functions
  // -----------------
  
  /**
   * @returns {boolean} Whether the user has permission to call getActiveUser().
   *                    This is a way to test if they are a custom function
   */
  
  function hasAuth() {
  
    try {
      Session.getActiveUser();
      return true;
    } catch (error) {
      return false; 
    }
    
  } // BBLog_.hasAuth
  
} // BBLog_()

/**
 * Logs at the SEVERE level. SEVERE is a message level indicating a serious failure.
 *
 * In general SEVERE messages should describe events that are of considerable 
 * importance and which will prevent normal program execution. They should be 
 * reasonably intelligible to end users and to system administrators. 
 *
 * @param  {object} message    The message to log or an sprintf-like format string (uses Utilities.formatString() internally - see http://www.perlmonks.org/?node_id=20519 as a good reference).
 * @param  {object...} optValues  If a format string is used in the message, a number of values to insert into the format string
 *
 * @returns {BetterLog} this object, for chaining
 */
 
BBLog_.prototype.severe = function(message, optValues) {

  this._log(arguments, Level.SEVERE);
  return this;  
  
} // BBLog.severe()

/**
 * Logs at the WARNING level. WARNING is a message level indicating a potential problem.
 *
 * In general WARNING messages should describe events that will be of interest 
 * to end users or system managers, or which indicate potential problems. 
 *
 * @param  {object} message    The message to log or an sprintf-like format string (uses Utilities.formatString() internally - see http://www.perlmonks.org/?node_id=20519 as a good reference).
 * @param  {Object...} optValues  If a format string is used in the message, a number of values to insert into the format string.
 *
 * @returns {BetterLog} this object, for chaining
 */

BBLog_.prototype.warning = function(message, optValues) {

  this._log(arguments, Level.WARNING);
  return this;
  
} // BBLog.warning()

/**
 * Logs at the INFO level. INFO is a message level for informational messages.
 *
 * Typically INFO messages will be written to the console or its equivalent. 
 * So the INFO level should only be used for reasonably significant messages 
 * that will make sense to end users and system administrators. 
 *
 * @param  {object} message    The message to log or an sprintf-like format string (uses Utilities.formatString() internally - see http://www.perlmonks.org/?node_id=20519 as a good reference).
 * @param  {Object...} optValues  If a format string is used in the message, a number of values to insert into the format string.
 *
 * @returns {BetterLog} this object, for chaining
 */
 
BBLog_.prototype.info = function(message, optValues) {

  this._log(arguments, Level.INFO);
  return this;
  
} // BBLog.info()

/**
* Logs at the INFO level. INFO is a message level for informational messages.
*
* Typically INFO messages will be written to the console or its equivalent. 
* So the INFO level should only be used for reasonably significant messages 
* that will make sense to end users and system administrators. 
*
* @param  {object} message    The message to log or an sprintf-like format string (uses Utilities.formatString() internally - see http://www.perlmonks.org/?node_id=20519 as a good reference).
* @param  {object...} optValues  If a format string is used in the message, a number of values to insert into the format string.
*
* @returns {BetterLog} this object, for chaining
*/

BBLog_.prototype.log = function(message, optValues) {

  this._log(arguments, Level.INFO);
  return this;
  
} // BBLog.log()

/**
 * Logs at the CONFIG level. CONFIG is a message level for static 
 * configuration messages.
 *
 * CONFIG messages are intended to provide a variety of static configuration 
 * information, to assist in debugging problems that may be associated with 
 * particular configurations. 
 *
 * @param  {object} message    The message to log or an sprintf-like format string (uses Utilities.formatString() internally - see http://www.perlmonks.org/?node_id=20519 as a good reference).
 * @param  {Object...} optValues  If a format string is used in the message, a number of values to insert into the format string.
 *
 * @returns {BetterLog} this object, for chaining
 */

BBLog_.prototype.config = function(message, optValues) {

  this._log(arguments, Level.CONFIG);
  return this;
  
} // BBLog.config()

/**
 * Logs at the FINE level. FINE is a message level providing tracing information.
 * 
 * All of FINE, FINER, and FINEST are intended for relatively detailed tracing. 
 * The exact meaning of the three levels will vary between subsystems, but in general, 
 * FINEST should be used for the most voluminous detailed output, 
 * FINER for somewhat less detailed output, and FINE for the lowest volume (and 
 * most important) messages.
 * 
 * In general the FINE level should be used for information that will be broadly 
 * interesting to developers who do not have a specialized interest in the specific 
 * subsystem. FINE messages might include things like minor (recoverable) failures. 
 * Issues indicating potential performance problems are also worth logging as FINE. 
 *
 * @param  {object} message    The message to log or an sprintf-like format string (uses Utilities.formatString() internally - see http://www.perlmonks.org/?node_id=20519 as a good reference).
 * @param  {Object...} optValues  If a format string is used in the message, a number of values to insert into the format string.
 *
 * @returns {BetterLog} this object, for chaining
 */
 
BBLog_.prototype.fine = function(message, optValues) {

  this._log(arguments, Level.FINE);
  return this;
  
} // BBLog.fine()

/**
 * Logs at the FINER level. FINER indicates a fairly detailed tracing message.
 * 
 * @param  {object} message The message to log or an sprintf-like format string (uses Utilities.formatString() internally - see http://www.perlmonks.org/?node_id=20519 as a good reference).
 * @param  {Object...} optValues  If a format string is used in the message, a number of values to insert into the format string.
 *
 * @returns {BetterLog} this object, for chaining
 */

BBLog_.prototype.finer = function(message, optValues) {

  this._log(arguments, Level.FINER);
  return this;
  
} // BBLog.finer()

/**
 * Logs at the FINEST level. FINEST indicates a highly detailed tracing message. 
 *
 * @param  {object} message The message to log or an sprintf-like format string (uses Utilities.formatString() internally - see http://www.perlmonks.org/?node_id=20519 as a good reference).
 * @param  {Object...} optValues  If a format string is used in the message, a number of values to insert into the format string.
 *
 * @returns {BetterLog} this object, for chaining
 */

BBLog_.prototype.finest = function(message, optValues) {

  this._log(arguments, Level.FINEST);
  return this;
  
} // BBLog.finest()

/**
 * Optionally included as the first function called in a function, and logged as 
 * FINEST. Used to map all function calls.
 *
 * @param {object} message The message to log or an sprintf-like format string (uses Utilities.formatString() internally - see http://www.perlmonks.org/?node_id=20519 as a good reference).
 * @param {Object...} options If a format string is used in the message, a number of values to insert into the format string.
 *
 * @returns {Log} This object, for chaining
 */
   
BBLog_.prototype.functionEntryPoint = function(message, options) {

  this._log(arguments, Level.FINEST);
  return this;

} // BBLog.functionEntryPoint()

/**
 * Get the present value the level is set to as a string
 *
 * @returns {BBLog.Level} BBLog level object {name: {String}, value {Number}}
 */

BBLog_.prototype.getLevel = function() {

  var level = null;
  
  for (var key in Level) {
    if (Level[key].value === this.minLevelToDisplay) {
      level = Level[key]
      break;
    }
  }

  if (level === null) {
    throw new Error('Bad level value stored internally')
  }

  return level;
  
} // BBLog.getLevel()

/**
 * Sets the new log level
 *
 * @param  {BBLog.Level} logLevel The new log level
 *
 * @returns {BBLog} this object, for chaining
 */

BBLog_.prototype.setLevel = function(level) {

  if (!Level.hasOwnProperty(level.name)) {
    throw new Error('level is not a BBLog.Level');
  }

  if (this.minLevelToDisplay !== level.value) {
    this.minLevelToDisplay = level.value;
  }
  
  return this;
  
} // BBLog.setLevel()

/**
 * Clear the debug log 
 */
   
BBLog_.prototype.clear = function() {

  if (this.localFirebase !== null) {
  
    var data = this.localFirebase.getData();

    for (var index in data) {
      this.localFirebase.removeData(index)
    }
  }
  
  if (this.localSheet !== null) {
    this.localSheet.clearContents();
    this.localSheet.getRange(1,1).setValue(SHEET_LOG_HEADER_);
    this.localSheet.setFrozenRows(1);
    this.localSheet.setColumnWidth(1, SHEET_LOG_CELL_WIDTH_);    
    SpreadsheetApp.flush();
  }
  
  if (this.localFirebase === null && this.localSheet === null) {
    throw new Error('Set up the logging destination first')
  }
  
} // BBLog.clear()

/**
 * For remote logging
 */
 
BBLog_.prototype.remoteLogProxy = function(e) {

  if (e && e.parameter.betterlogmsg) {
    Utils_.callWithBackoff(function() {this.localSheet.appendRow([e.parameter.betterlogmsg]);});
  }
  
} // BBLog.remoteLogProxy()

/********************************************************************************
 * Private Methods
 *****************/

/**
 * Allows logging to a Google spreadsheet. Sets the log sheet, creating 
 * one if it doesn't exist
 *
 * @param {string} key The spreadsheet key [OPTIONAL, DEFAULT: active spreadsheet]
 * @param {string} sheetName The name of the sheet 
 * @param {boolean} hideLog
 */
 
BBLog_.prototype._useSpreadsheet = function(key, sheetName, hideLog) {

  var spreadsheet;

  if (typeof key !== 'undefined' && key !== '') {  
    spreadsheet = SpreadsheetApp.openById(key); 
  } else {
    spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  }
  
  var sheets = Utils_.callWithBackoff(function() {
    return spreadsheet.getSheets();
  });
  
  var numberOfSheets = sheets.length
  var sheet = null;
  
  for (var sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {  
    if (sheets[sheetIndex].getName() === sheetName) {
      sheet = sheets[sheetIndex];
    }
  }
  
  if (sheet === null) { 
    sheet = spreadsheet.insertSheet(sheetName, numberOfSheets);
    formatLog()
  }

  if (hideLog) {
    sheet.hideSheet()
  }

  sheet.getRange(1,1).setValue(SHEET_LOG_HEADER_); // In case we need to update
  return sheet
  
  // Private Functions
  // -----------------
  
  /**
   * Set up the formatting of the log sheet
   */
    
  function formatLog() {

    sheet.deleteColumns(2, sheet.getMaxColumns() - 1);
    
    sheet
      .getRange(1,1)
      .setValue(SHEET_LOG_HEADER_)
      .setFontWeight('bold')
      .setBackground('grey')
      .setFontColor('white');
      
    sheet.setFrozenRows(1);
    
    sheet.setColumnWidth(1, SHEET_LOG_CELL_WIDTH_);    

    var conditionalFormatRules = sheet.getConditionalFormatRules();
    
    conditionalFormatRules.push(SpreadsheetApp.newConditionalFormatRule()
      .setRanges([spreadsheet.getRange('A2:A1000')])
      .whenTextContains('SEVERE')
      .setBackground('#F4C7C3')
      .build());
    
    conditionalFormatRules.push(SpreadsheetApp.newConditionalFormatRule()
      .setRanges([spreadsheet.getRange('A2:A1000')])
      .whenTextContains('WARNING')
      .setBackground('#FCE8B2')
      .build());
   
    conditionalFormatRules.push(SpreadsheetApp.newConditionalFormatRule()
      .setRanges([spreadsheet.getRange('A2:A1000')])
      .whenTextContains('INFO')
      .setBackground('#B7E1CD')
      .build());
    
    sheet.setConditionalFormatRules(conditionalFormatRules);
    
  } // BBLog_.useSpreadsheet_.formatLog()
  
} // BBLog_.useSpreadsheet_()

/**
 * Record the id of the active user
 *
 * @param {Log.DisplayUserId} storeId 
 */
 
BBLog_.prototype._storeUserId = function(storeId) {

  var userId = null;
  var userEmail = null;

  if (storeId === DisplayUserId.USER_KEY_HIDE || storeId === DisplayUserId.USER_KEY_FULL) {
  
    userId = Session.getTemporaryActiveUserKey() || null
    
    if (userId) {
    
      if (storeId === DisplayUserId.USER_KEY_HIDE) {
      
        // Just get the last USER_ID_LENGTH_ chars, otherwise it is too long
        userId = '...' + userId.slice(-USER_ID_LENGTH_) + ' ';
        
      } else {
      
        userId = userId + ' ';
      }
    }
  
  } else if (storeId === DisplayUserId.EMAIL_HIDE || storeId === DisplayUserId.EMAIL_FULL) {
  
    userEmail = Session.getEffectiveUser().getEmail()
    
    if (userEmail) {
      
      if (storeId === DisplayUserId.EMAIL_HIDE) {
      
        userEmail = hideEmailUser(userEmail) + ' ';
        
      } else {
      
        userEmail = userEmail + ' ';
      }
    }
  
  } else if (storeId === DisplayUserId.NONE) {
  
    // Leave the both as null

  } else {
  
    throw new Error('Bad user ID type')
  }
  
  return {
    userId: userId,
    userEmail: userEmail,
  }
  
  // Private Functions
  // -----------------
  
  /**
   * Hide the user's email address by removing the middle letters of the user
   *
   * @param {string} email
   *
   * @returns {string} Hidden email or ''
   */
  
  function hideEmailUser(email) {  
  
    if (typeof email !== 'string' || email === '') {
      return '';
    }
    
    var nameParts = email.split("@");
    
    if (nameParts.length !== 2) {
      // Invalid email address
      return '';
    }
    
    var name = nameParts[0];
    var domain = nameParts[1];  
    var hiddenName;
    
    if (name.length <= 2) {
      hiddenName = name;
    } else {
      hiddenName = name.slice(0,1) + '...' + name.slice(-1);
    }
    
    return hiddenName + '@' + domain;
    
  } // BBLog_.storeUserId.hideEmailUser()
  
} // BBLog_.storeUserId()

/**
 * Core logger function
 */

BBLog_.prototype._log = function(oldArgs, level) {

  if (level.value < this.minLevelToDisplay) {
    return;
  }
  
  var self = this;
  
  // get args and transform objects to strings like the native logger does
  var newArgs = Array.prototype.slice.call(oldArgs).map(function(arg) {  
    var type = typeof arg;
    if (type === 'undefined') {
      return 'undefined';
    }
    return (arg !== null && type === 'object') ? JSON.stringify(arg, null, JSON_SPACES_) : arg;
  });

  var messageString
  
  // check if the args contain a printf() type list of parameters
  if (typeof newArgs[0] === 'string' || newArgs[0] instanceof String) {
    messageString = Utilities.formatString.apply(this, newArgs);
  } else {
    messageString = newArgs[0] || '';  
  }

  // default console logging (built in with Google Apps Script's View > Logs...)
  if (this.nativeLogger) {
    this.nativeLogger.log(convertUsingDefaultPatternLayout(messageString, level));
  }
  
  if (this.localSheet !== null) {
    logToSheet(messageString, level);  
  } 
  
  if (this.localFirebase !== null) { 
    logToFirebase(messageString, level);
  }
  
  if (this.useStackdriver) {
  
    messageString = convertUsingDefaultPatternLayout(messageString, level);
  
    if (level.value <= Level.INFO.value) {
      console.info(messageString);  
    } else if (level.value === Level.WARNING.value) {
      console.warn(messageString);      
    } else if (level.value === Level.SEVERE.value) {
      console.error(messageString);
    } else {
      // Do nothing 
    }
  }
  
  return
  
  // Private Functions
  // -----------------
  
  function logToSheet(shortMessage, level) {
  
    if (self._incCallCountToSheetLog() % self.rollerRowCount === 0) {
      self._rollLogOver();
    }
    
    var longMessage = convertUsingDefaultPatternLayout(shortMessage, level);
    
    if (self.useRemoteLogger) {
    
      var url = ScriptApp.getService().getUrl()+'?betterlogmsg=' + longMessage;
      
      Utils_.callWithBackoff(function() {
        UrlFetchApp.fetch(url);
      });
      
    } else {
    
      Utils_.callWithBackoff(function() {      
        self.localSheet.appendRow([longMessage]);
      });
    }
    
  } // BBLog_._log.logToSheet()
  
  // logs to Firebase database
  
  function logToFirebase(messageString, level) {
  
    var messageObject = convertToObject(messageString, level);
    
    self.localFirebase.setData(
      messageObject.key, // timestamp
      {
        sinceStart: messageObject.body.sinceStart,
        priority: messageObject.body.priority, 
        id: messageObject.body.id, 
        message: messageObject.body.message
      }
    )
    
    // Private Functions
    // -----------------
    
    function convertToObject(msg, level) {
    
      var now = new Date;
      var dt = Utilities.formatDate(now, Session.getScriptTimeZone(), DATE_TIME_LAYOUT_);
      
      return {
        key: dt,
        body: {
          sinceStart: Utilities.formatString('%06d', now - self.startTime),
          priority: level.name, 
          id: (self.userId) ? self.userId : ((self.userEmail) ? self.userEmail : ''), 
          message: self._getFunctionName() + msg,
        }
      }
      
    } // BBLog_._log.logToFirebase.convertToObject()
    
  } // BBLog_._log.logToFirebase
  
  // convert message to text string
  
  function convertUsingDefaultPatternLayout (logMessage, level) {
  
    var now = new Date;
    var timestamp = Utilities.formatDate(now, Session.getScriptTimeZone(), DATE_TIME_LAYOUT_) + ' ';
    var timeSinceStart = Utilities.formatString('%06d', now - self.startTime) + ' '
    var userIdString = (self.userId) ? self.userId : ((self.userEmail) ? self.userEmail : '')
    var levelString = level.name + " "
    var remoteLoggingString = self.useRemoteLogger ? 'REMOTE ': ''
    var functionName = self._getFunctionName()
    
    var formattedMessage = 
      timestamp + 
      timeSinceStart +     
      userIdString +                 
      levelString +         
      remoteLoggingString +  
      functionName + 
      logMessage;                                  
      
    return formattedMessage;
    
  } // BBLog_._log.convertUsingDefaultPatternLayout()
  
} // BBLog_._log()

    /**
     * This uses a forced error to get the stack trace rather than using 
     * arguments.callee.name which is deprecated in strict ES5. 
     *
     * @returns {String} function name or ''
     */
     
BBLog_.prototype._getFunctionName = function() {
      
  var functionName = ''
  
  if (this.displayFunctionNames) {
    
    try {
      
      throw new Error('Throw error to get stack trace');
      
    } catch (error) {
      
      // The calling function we're interested in is up a few levels
      functionName = error.stack.split('\n')[5].replace('\t', '') + ' ';
    } 
  }
  
  return functionName
      
}, // BBLog_._getFunctionName()
   
// rolls over the log if we need to

BBLog_.prototype._rollLogOver = function() {

  var self = this

  var rowCount = Utils_.callWithBackoff(function() {
    return self.localSheet.getLastRow();
  });
  
  if (rowCount <= this.maxRows) {
    return;
  }
    
  // get a lock or throw exception
  var gotLockObject = (this.lock !== null);
  
  // try for 10 secs to get a lock (else error), long enough to rollover the log 
  var alreadyHaveLock
  if (gotLockObject) {  
    alreadyHaveLock = this.lock.hasLock()
    if (!alreadyHaveLock) {
      this.lock.waitLock(10000); 
    }
  }
  
  // copy the log
  var ss = this.localSheet.getParent();
  var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), DATE_TIME_LAYOUT_);
  var ssName = ss.getName() + ' as at ' + timestamp;
  var oldLogSs;
  
  // SpreadsheetApp.getActiveSheet().copyTo(spreadsheet).setName(name)
  
  if (this.backupWholeSS) {  
    oldLogSs = ss.copy(ssName);  
  } else {
    oldLogSs = SpreadsheetApp.create(ssName);
    this.localSheet.copyTo(oldLogSs).setName(this.sheetName);
    oldLogSs.deleteSheet(oldLogSs.getSheetByName('Sheet1'));
  }
 
  if (this.backupFolder) {
    oldLogFile = DriveApp.getFileById(oldLogSs.getId())
    DriveApp.getRootFolder().removeFile(oldLogFile)
    this.backupFolder.addFile(oldLogFile)
  }
 
  // add current viewers and editors to old log
  oldLogSs.addViewers(ss.getViewers());
  oldLogSs.addEditors(ss.getEditors());
  
  // prep the live log
  this.localSheet.deleteRows(2, this.localSheet.getMaxRows() - 2);
  this.localSheet.getRange(1,1).setValue(SHEET_LOG_HEADER_);
  
  // update the log
  this.localSheet
    .getRange("A2")
    .setValue(['Log reached ' + rowCount + ' rows (MAX_ROWS is ' + this.maxRows + ') and was cleared. Previous log is available here:']);
    
  this.localSheet.appendRow([oldLogSs.getUrl()]);
  
  // release lock unless it was already "held"
  if (!alreadyHaveLock && gotLockObject) {
    this.lock.releaseLock();
  }
  
} // BBLog_._rollLogOver

/**
 * Count the log call when logging to a sheet
 *
 * @returns {number} count
 */

BBLog_.prototype._incCallCountToSheetLog = (function () {

  var count = 0;
  
  return function () {
    count++;
    return count
  }
  
})(); // incCallCountToSheetLog_()

/*******************************************************************************
 * Private Utility Functions 
 ***************************/

var Utils_ = {

/**
 * Exponential backoff - Copy of version 10 lib GASRetry 'MGJu3PS2ZYnANtJ9kyn2vnlLDhaBgl_dE' 
 *
 * @param  {function} functionName
 *
 * @returns {object} Result of function call
 */

callWithBackoff: function(functionName) {

  if (DISABLE_BACKOFF_) {
    return functionName()
  }

  for (var tryCount = 0; tryCount < 6; tryCount++) {
    try {
      return functionName();
    } catch(error) {
      if (tryCount === 5) {
        throw error;
      }
      Utilities.sleep((Math.pow(2,tryCount)*1000) + (Math.round(Math.random() * 1000)));
    }    
  }
  
}, // Utils_.callWithBackoff()

} // Utils_

/**
 *
 *
 * @param {object} 
 *
 * @returns {object} 
 */

function functionTemplate_() {

  

}  // functionTemplate_()

function test() {
  var a = DriveApp.getFileById('1iwMdhp86eys-37GJr0EVvlWK2Gp2-3ZvDQhGMEy7VqU')
  debugger
}
