/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2009 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

/**
 * @fileOverview Tools for automatically retrieving a citation for the given PDF
 */

Zotero.RecognizePDF = new function () {
	const GOOGLE_SCHOLAR_QUERY_DELAY = 30 * 1000;
	
	this.lastGoogleScholarQueryTime = 0;
	
	this.ROW_QUEUED = 1;
	this.ROW_PROCESSING = 2;
	this.ROW_FAILED = 3;
	this.ROW_SUCCEEDED = 4;
	
	this.onRowAdded = null;
	this.onRowUpdated = null;
	this.onRowDeleted = null;
	
	this.rows = [];
	
	this.mainQueue = [];
	this.mainQueueProcessing = false;
	this.GSQueue = [];
	this.GSQueueProcessing = false;
	
	this.getRows = function () {
		return this.rows;
	};
	
	this.getTotal = function () {
		return this.rows.length;
	};
	
	this.getProcessed = function () {
		let processed = 0;
		for (let i = 0; i < this.rows.length; i++) {
			let row = this.rows[i];
			if (row.status > this.ROW_PROCESSING) {
				processed++;
			}
		}
		return processed;
	};
	
	this.cancel = function () {
		this.mainQueue = [];
		this.GSQueue = [];
		this.rows = [];
	};
	
	this.addItem = function (item) {
		for (let i = 0; i < this.rows.length; i++) {
			let row = this.rows[i];
			if (row.id === item.id) {
				if (row.status > this.ROW_PROCESSING) {
					this.deleteRow(row.id);
					break;
				}
				return null;
			}
		}
		
		let row = {
			id: item.id,
			status: Zotero.RecognizePDF.ROW_QUEUED,
			fileName: item.getField('title'),
			message: ''
		};
		
		this.rows.push(row);
		
		this.mainQueue.push(item.id);
		
		if (typeof this.onRowAdded === 'function') {
			this.onRowAdded(row);
		}
	};
	
	this.updateRow = function (itemID, status, message) {
		for (let i = 0; i < this.rows.length; i++) {
			let row = this.rows[i];
			if (row.id === itemID) {
				row.status = status;
				row.message = message;
				if (typeof this.onRowUpdated === 'function') {
					this.onRowUpdated({
						id: row.id,
						status,
						message: message || ''
					});
				}
				return;
			}
		}
	};
	
	this.deleteRow = function (itemID) {
		for (let i = 0; i < this.rows.length; i++) {
			let row = this.rows[i];
			if (row.id === itemID) {
				this.rows.splice(i, 1);
				if (typeof this.onRowDeleted === 'function') {
					this.onRowDeleted({
						id: row.id
					});
				}
				return;
			}
		}
	};
	
	this.processMainQueue = async function () {
		let itemID;
		if (this.mainQueueProcessing) return;
		
		this.mainQueueProcessing = true;
		
		while (itemID = this.mainQueue.shift()) {
			this.updateRow(itemID, Zotero.RecognizePDF.ROW_PROCESSING, 'processing');
			
			try {
				
				let newItem = await this.processItem(itemID);
				
				if (newItem) {
					this.updateRow(itemID, Zotero.RecognizePDF.ROW_SUCCEEDED, newItem.getField('title'));
				}
				else {
					this.updateRow(itemID, Zotero.RecognizePDF.ROW_QUEUED, 'queued for GS');
				}
			}
			catch (e) {
				Zotero.logError(e);
				
				this.updateRow(
					itemID,
					Zotero.RecognizePDF.ROW_FAILED,
					e instanceof Zotero.Exception.Alert
						? e.message
						: Zotero.getString("recognizePDF.error")
				);
			}
		}
		
		this.mainQueueProcessing = false;
	};
	
	this.processGSQueue = async function () {
		let data;
		if (this.GSQueueProcessing) return;
		
		this.GSQueueProcessing = true;
		
		while (1) {
			
			let delay = GOOGLE_SCHOLAR_QUERY_DELAY - (Date.now() - this.lastGoogleScholarQueryTime);
			
			if (delay > 0) {
				await Zotero.Promise.delay(delay);
			}
			
			this.lastGoogleScholarQueryTime = Date.now();
			
			data = this.GSQueue.shift();
			
			if (!data) break;
			
			let itemID = data.itemID;
			let queryString = data.queryStrings[0];
			this.updateRow(itemID, Zotero.RecognizePDF.ROW_PROCESSING, 'processing');
			
			try {
				
				let newItem = await this.processItemGS(itemID, queryString);
				
				if (newItem) {
					this.updateRow(itemID, Zotero.RecognizePDF.ROW_SUCCEEDED, newItem.getField('title'));
				}
				else {
					data.queryStrings.shift();
					if (data.queryStrings.length) {
						this.updateRow(itemID, Zotero.RecognizePDF.ROW_QUEUED, 'queued for GS for another attempt');
						this.GSQueue.push(data);
					}
					else {
						this.updateRow(itemID, Zotero.RecognizePDF.ROW_FAILED, 'not found');
					}
				}
			}
			catch (e) {
				Zotero.logError(e);
				
				this.updateRow(
					itemID,
					Zotero.RecognizePDF.ROW_FAILED,
					e instanceof Zotero.Exception.Alert
						? e.message
						: Zotero.getString("recognizePDF.error")
				);
			}
		}
		
		this.GSQueueProcessing = false;
	};
	
	this.processItem = async function (itemID) {
		let item = await Zotero.Items.getAsync(itemID);
		
		if (!item) throw new Zotero.Exception.Alert('recognizePDF.fileNotFound');
		
		if (item.parentItemID) throw new Zotero.Exception.Alert('recognizePDF.fileNotFound');
		
		let file = item.getFile();
		
		//let path = yield this.getFilePathAsync();
		
		if (!file) throw new Zotero.Exception.Alert('recognizePDF.fileNotFound');
		
		const MAX_PAGES = 15;
		
		let lines = await _extractText(file, MAX_PAGES);
		let newItem = await Zotero.RecognizePDF.recognize(
			item,
			lines,
			item.libraryID
		);
		
		if (newItem) {
			// put new item in same collections as the old one
			let itemCollections = item.getCollections();
			await Zotero.DB.executeTransaction(async function () {
				for (let i = 0; i < itemCollections.length; i++) {
					let collection = Zotero.Collections.get(itemCollections[i]);
					await collection.addItem(newItem.id);
				}
				
				// put old item as a child of the new item
				item.parentID = newItem.id;
				await item.save();
			});
			
			return newItem
		}
		
		let queryStrings = this.GSFullTextSearch.getQueries(lines, 3);
		if (queryStrings.length) {
			this.GSQueue.push({
				itemID: item.id,
				queryStrings
			});
			
			Zotero.debug('tttaaa ' + JSON.stringify(this.GSQueue));
			this.processGSQueue();
		}
		
		return null;
	};
	
	this.processItemGS = async function (itemID, queryString) {
		let item = await Zotero.Items.getAsync(itemID);
		if (!item) throw new Zotero.Exception.Alert('recognizePDF.fileNotFound');
		
		let newItem = await this.GSFullTextSearch.recognize(item.libraryID, queryString);
		
		if (newItem) {
			// put new item in same collections as the old one
			let itemCollections = item.getCollections();
			await Zotero.DB.executeTransaction(async function () {
				for (let i = 0; i < itemCollections.length; i++) {
					let collection = Zotero.Collections.get(itemCollections[i]);
					await collection.addItem(newItem.id);
				}
				
				// put old item as a child of the new item
				item.parentID = newItem.id;
				await item.save();
			});
			
			return newItem;
		}
		
		return null;
	};
	
	/**
	 * Checks whether a given PDF could theoretically be recognized
	 * @returns {Boolean} True if the PDF can be recognized, false if it cannot be
	 */
	this.canRecognize = function (/**Zotero.Item*/ item) {
		return item.attachmentMIMEType
			&& item.attachmentMIMEType === 'application/pdf'
			&& item.isTopLevelItem();
	};
	
	/**
	 * Retrieves metadata for the PDF(s) selected in the Zotero Pane, placing the PDFs as a children
	 * of the new items
	 */
	this.recognizeItems = function (items) {
		// let installed = ZoteroPane_Local.checkPDFConverter();
		// if (!installed) {
		// 	return;
		// }
		
		for (let i = 0; i < items.length; i++) {
			this.addItem(items[i]);
		}
		
		this.processMainQueue();
	};
	
	/**
	 * Retrieves metadata for a PDF and saves it as an item
	 *
	 * @param {nsIFile} file The PDF file to retrieve metadata for
	 * @param {Integer} libraryID The library in which to save the PDF
	 * @param {Function} stopCheckCallback Function that returns true if the
	 *                   process is to be interrupted
	 * @return {Promise} A promise resolved when PDF metadata has been retrieved
	 */
	this.recognize = async function (item, lines, libraryID) {
		// Look for DOI - Use only first 80 lines to avoid catching article references
		let allText = lines.join('\n');
		let firstChunk = lines.slice(0, 80).join('\n');
		let doi = Zotero.Utilities.cleanDOI(firstChunk);
		
		if (!doi) {
			// Look for a JSTOR stable URL, which can be converted to a DOI by prepending 10.2307
			doi = firstChunk.match(/www.\jstor\.org\/stable\/(\S+)/i);
			if (doi) {
				doi = Zotero.Utilities.cleanDOI(
					doi[1].indexOf('10.') == 0 ? doi[1] : '10.2307/' + doi[1]
				);
			}
		}
		
		let newItem;
		if (doi) {
			// Look up DOI
			Zotero.debug('RecognizePDF: Found DOI: ' + doi);
			
			let translateDOI = new Zotero.Translate.Search();
			translateDOI.setTranslator('11645bd1-0420-45c1-badb-53fb41eeb753');
			translateDOI.setSearch({'itemType': 'journalArticle', 'DOI': doi});
			try {
				newItem = await _promiseTranslate(translateDOI, libraryID);
				return newItem;
			}
			catch (e) {
				Zotero.debug('RecognizePDF: ' + e);
			}
		}
		else {
			Zotero.debug('RecognizePDF: No DOI found in text');
		}
		
		// Look for ISBNs if no DOI
		let isbns = _findISBNs(allText);
		if (isbns.length) {
			Zotero.debug('RecognizePDF: Found ISBNs: ' + isbns);
			
			let translate = new Zotero.Translate.Search();
			translate.setSearch({'itemType': 'book', 'ISBN': isbns[0]});
			try {
				newItem = await _promiseTranslate(translate, libraryID);
				return newItem;
			}
			catch (e) {
				// If no DOI or ISBN, query Google Scholar
				Zotero.debug('RecognizePDF: ' + e);
			}
		}
		else {
			Zotero.debug('RecognizePDF: No ISBN found in text');
		}
		
		newItem = await this.ZoteroFulltextIdentify.findItem(item);
		if (newItem) return newItem;
		
		//return Zotero.Promise.resolve(null);
		//return this.GSFullTextSearch.findItem(lines, libraryID, stopCheckCallback);
		return null;
	};
	
	/**
	 * Get text from a PDF
	 * @param {nsIFile} file PDF
	 * @param {Number} pages Number of pages to extract
	 * @return {Promise}
	 */
	function _extractText(file, pages) {
		let lines = [];
		let cacheFile = Zotero.File.pathToFile(Zotero.DataDirectory.dir);
		cacheFile.append('recognizePDFcache.txt');
		if (cacheFile.exists()) {
			cacheFile.remove(false);
		}
		
		let {exec, args} = Zotero.Fulltext.getPDFConverterExecAndArgs();
		args.push('-enc', 'UTF-8', '-nopgbrk', '-layout', '-l', pages, file.path, cacheFile.path);
		
		Zotero.debug('RecognizePDF: Running ' + exec.path + ' ' + args.map(arg => "'" + arg + "'").join(' '));
		
		return Zotero.Utilities.Internal.exec(exec, args).then(function () {
			if (!cacheFile.exists()) {
				throw new Zotero.Exception.Alert('recognizePDF.couldNotRead');
			}
			
			try {
				let inputStream = Components.classes['@mozilla.org/network/file-input-stream;1']
					.createInstance(Components.interfaces.nsIFileInputStream);
				inputStream.init(cacheFile, 0x01, 0o664, 0);
				try {
					let intlStream = Components.classes['@mozilla.org/intl/converter-input-stream;1']
						.createInstance(Components.interfaces.nsIConverterInputStream);
					intlStream.init(inputStream, 'UTF-8', 65535,
						Components.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
					intlStream.QueryInterface(Components.interfaces.nsIUnicharLineInputStream);
					
					// get the lines in this sample
					let str = {};
					while (intlStream.readLine(str)) {
						let line = str.value.trim();
						if (line) lines.push(line);
					}
				}
				finally {
					inputStream.close();
				}
			}
			finally {
				cacheFile.remove(false);
			}
			
			return lines;
		}, function () {
			throw new Zotero.Exception.Alert('recognizePDF.couldNotRead');
		});
	}
	
	/**
	 * Attach appropriate handlers to a Zotero.Translate instance and begin translation
	 * @return {Promise}
	 */
	let _promiseTranslate = async function (translate, libraryID) {
		translate.setHandler('select', function (translate, items, callback) {
			for (let i in items) {
				let obj = {};
				obj[i] = items[i];
				callback(obj);
				return;
			}
		});
		
		let newItems = await translate.translate({
			libraryID,
			saveAttachments: false
		});
		if (newItems.length) {
			return newItems[0];
		}
		throw new Error('No items found');
	};
	
	/**
	 * Search ISBNs in text
	 * @private
	 * @return {String[]} Array of ISBNs
	 */
	function _findISBNs(x) {
		if (typeof(x) !== 'string') {
			throw 'findISBNs: argument must be a string';
		}
		let isbns = [];
		
		// Match lines saying 'isbn: ' or 'ISBN-10:' or similar, consider m-dashes and n-dashes as well
		let pattern = /(SBN|sbn)[ \u2014\u2013\u2012-]?(10|13)?[: ]*([0-9X][0-9X \u2014\u2013\u2012-]+)/g;
		let match;
		
		while (match = pattern.exec(x)) {
			let isbn = match[3];
			isbn = isbn.replace(/[ \u2014\u2013\u2012-]/g, '');
			if (isbn.length === 20 || isbn.length === 26) {
				// Handle the case of two isbns (e.g. paper+hardback) next to each other
				isbns.push(isbn.slice(0, isbn.length / 2), isbn.slice(isbn.length / 2));
			}
			else if (isbn.length === 23) {
				// Handle the case of two isbns (10+13) next to each other
				isbns.push(isbn.slice(0, 10), isbn.slice(10));
			}
			else if (isbn.length === 10 || isbn.length === 13) {
				isbns.push(isbn);
			}
		}
		
		// Validate ISBNs
		let validIsbns = [], cleanISBN;
		for (let i = 0; i < isbns.length; i++) {
			cleanISBN = Zotero.Utilities.cleanISBN(isbns[i]);
			if (cleanISBN) validIsbns.push(cleanISBN);
		}
		return validIsbns;
	}
	
	
	this.ZoteroFulltextIdentify = new function () {
		let query = async function (hash, fulltext) {
			let body = JSON.stringify({
				hash: hash,
				text: fulltext
			});
			
			let uri = 'http://54.87.124.65:8003/recognize';
			
			let req = await Zotero.HTTP.request(
				'POST',
				uri,
				{
					headers: {
						'Content-Type': 'application/json'
					},
					debug: true,
					body: body
				}
			);
			// This is temporary, until we'll have a normal endpoint
			let json = JSON.parse(req.responseText);
			if (json.title || json.identifiers) {
				return json;
			}
			
			return null;
		};
		
		function processText(text) {
			let rx = Zotero.Utilities.XRegExp('[^\\pL\n]', 'g');
			text = Zotero.Utilities.XRegExp.replace(text, rx, '');
			text = text.normalize('NFKD');
			text = Zotero.Utilities.XRegExp.replace(text, rx, '');
			text = text.toLowerCase();
			
			let linesMap = [];
			let prevIsLine = false;
			for (let i = 0; i < text.length; i++) {
				if (text.charAt(i) === '\n') {
					prevIsLine = true;
				}
				else {
					linesMap.push(prevIsLine);
					prevIsLine = false;
				}
			}
			
			text = text.replace(/\n/g, '');
			
			return {
				linesMap,
				text
			}
		}
		
		function validateMetadata(fulltext, title) {
			let processedFulltext = processText(fulltext);
			
			title = Zotero.Utilities.unescapeHTML(title);
			
			let columnIndex = title.indexOf(':');
			if (columnIndex >= 30) title = title.slice(0, columnIndex);
			let processedTitle = processText(title);
			
			let titleIndex;
			// There can be multiple occurrences of title
			while ((titleIndex = processedFulltext.text.indexOf(processedTitle.text, titleIndex + 1)) >= 0) {
				if (titleIndex === 0 || titleIndex > 0 && processedFulltext.linesMap[titleIndex]) {
					return true;
				}
			}
			
			Zotero.debug('RecognizePDF: Title is invalid: ' + title);
			return false;
		}
		
		this.findItem = async function (item) {
			let hash = await item.attachmentHash;
			
			let fulltext = await Zotero.File.getContentsAsync(Zotero.FullText.getItemCacheFile(item));
			if (!fulltext) return null;
			
			fulltext = fulltext.slice(0, 16384);
			
			let res = await query(hash, fulltext);
			if (!res) return null;
			
			for (let i = 0; i < res.identifiers.length; i++) {
				let [type, identifier] = res.identifiers[i].split(':');
				if (type === 'doi') {
					Zotero.debug('RecognizePDF: Getting metadata by DOI');
					let translate = new Zotero.Translate.Search();
					translate.setTranslator('11645bd1-0420-45c1-badb-53fb41eeb753');
					translate.setSearch({'itemType': 'journalArticle', 'DOI': identifier});
					try {
						let translatedItems = await translate.translate({
							libraryID: false,
							saveAttachments: false
						});
						Zotero.debug('RecognizePDF: Translated items:');
						Zotero.debug(translatedItems);
						if (translatedItems.length) {
							if (validateMetadata(fulltext, translatedItems[0].title)) {
								let newItem = new Zotero.Item;
								newItem.fromJSON(translatedItems[0]);
								if (!newItem.abstractNote && res.abstract) {
									newItem.setField('abstractNote', res.abstract);
								}
								newItem.saveTx();
								return newItem;
							}
						}
					}
					catch (e) {
						Zotero.debug('RecognizePDF: ' + e);
					}
				}
				else if (type === 'isbn') {
					Zotero.debug('RecognizePDF: Getting metadata by ISBN');
					let translate = new Zotero.Translate.Search();
					translate.setSearch({'itemType': 'book', 'ISBN': identifier});
					try {
						let translatedItems = await translate.translate({
							libraryID: false,
							saveAttachments: false
						});
						Zotero.debug('RecognizePDF: Translated items:');
						Zotero.debug(translatedItems);
						if (translatedItems.length) {
							if (validateMetadata(fulltext, translatedItems[0].title)) {
								let newItem = new Zotero.Item;
								newItem.fromJSON(translatedItems[0]);
								if (!newItem.abstractNote && res.abstract) {
									newItem.setField('abstractNote', res.abstract);
								}
								newItem.saveTx();
								return newItem;
							}
						}
					}
					catch (e) {
						Zotero.debug('RecognizePDF: ' + e);
					}
				}
			}
			
			if (res.title) {
				let lookupAuthors = [];
				
				for (let i = 0; i < 2 && i < res.authors.length; i++) {
					let author = res.authors[i];
					if (author.lastName) {
						lookupAuthors.push(author.lastName);
					}
					else if (author.firstName) {
						lookupAuthors.push(author.firstName);
					}
				}
				
				lookupAuthors = lookupAuthors.join(' ');
				
				Zotero.debug('RecognizePDF: Getting metadata by title');
				let translate = new Zotero.Translate.Search();
				translate.setTranslator('0a61e167-de9a-4f93-a68a-628b48855909');
				translate.setSearch({'title': res.title, 'author': lookupAuthors});
				try {
					let translatedItems = await translate.translate({
						libraryID: false,
						saveAttachments: false
					});
					
					Zotero.debug('RecognizePDF: Translated items:');
					Zotero.debug(translatedItems);
					for (let j = 0; j < translatedItems.length; j++) {
						let translatedItem = translatedItems[j];
						if (validateMetadata(fulltext, translatedItem.title)) {
							let newItem = new Zotero.Item;
							newItem.fromJSON(translatedItem);
							
							if (!newItem.abstractNote && res.abstract) {
								newItem.setField('abstractNote', res.abstract);
							}
							
							await newItem.saveTx();
							return newItem;
						}
					}
				}
				catch (e) {
					Zotero.debug('RecognizePDF: ' + e);
				}
				
				let newItem = new Zotero.Item('journalArticle');
				newItem.setField('title', res.title);
				
				let creators = [];
				for (let i = 0; i < res.authors.length; i++) {
					let author = res.authors[i];
					creators.push({
						firstName: author.firstName,
						lastName: author.lastName,
						creatorType: 'author'
					})
				}
				
				newItem.setCreators(creators);
				
				if (res.abstract) newItem.setField('abstractNote', res.abstract);
				if (res.year) newItem.setField('date', res.year);
				
				newItem.setField('libraryCatalog', 'Zotero Metadata Service');
				
				await newItem.saveTx();
				return newItem;
			}
			
			
			return null;
		};
	};
	
	this.GSFullTextSearch = new function () {
		this.getQueries = function (lines, num) {
			
			let queryStrings = [];
			
			let goodLines = getGoodLines(lines);
			
			for (let i = 0; i < num; i++) {
				
				let queryString = '', queryStringWords = 0, nextLine = 0;
				while (queryStringWords < 25) {
					if (!goodLines.length) throw new Zotero.Exception.Alert('recognizePDF.noMatches');
					
					let words = goodLines.splice(nextLine, 1)[0].split(/\s+/);
					// Try to avoid picking adjacent strings so the odds of them appearing in another
					// document quoting our document is low. Every 7th line is a magic value
					nextLine = (nextLine + 7) % goodLines.length;
					
					// Get rid of first and last words
					words.shift();
					words.pop();
					// Make sure there are no long words (probably OCR mistakes)
					let skipLine = false;
					for (let j = 0; j < words.length; j++) {
						if (words[j].length > 20) {
							skipLine = true;
							break;
						}
					}
					// Add words to query
					if (!skipLine && words.length) {
						queryStringWords += words.length;
						queryString += '"' + words.join(' ') + '" ';
					}
				}
				queryStrings.push(queryString);
			}
			return queryStrings;
		};
		
		/**
		 * Select lines that are good candidates for Google Scholar query
		 * @private
		 * @param {String[]} lines
		 * @return {String[]}
		 */
		function getGoodLines(lines) {
			// Use only first column from multi-column lines
			const lineRe = /^[\s_]*([^\s]+(?: [^\s_]+)+)/;
			let cleanedLines = [], cleanedLineLengths = [];
			for (let i = 0; i < lines.length && cleanedLines.length < 100; i++) {
				let m = lineRe.exec(
					lines[i]
					// Replace non-breaking spaces
						.replace(/\xA0/g, ' ')
				);
				if (m && m[1].split(' ').length > 3) {
					cleanedLines.push(m[1]);
					cleanedLineLengths.push(m[1].length);
				}
			}
			
			// Get (not quite) median length
			let lineLengthsLength = cleanedLineLengths.length;
			if (lineLengthsLength < 20
				|| cleanedLines[0] === 'This is a digital copy of a book that was preserved for generations on library shelves before it was carefully scanned by Google as part of a project') {
				throw new Zotero.Exception.Alert('recognizePDF.noOCR');
			}
			
			let sortedLengths = cleanedLineLengths.sort(),
				medianLength = sortedLengths[Math.floor(lineLengthsLength / 2)];
			
			// Pick lines within 6 chars of the median (this is completely arbitrary)
			let goodLines = [],
				uBound = medianLength + 6,
				lBound = medianLength - 6;
			for (let i = 0; i < lineLengthsLength; i++) {
				if (cleanedLineLengths[i] > lBound && cleanedLineLengths[i] < uBound) {
					// Strip quotation marks so they don't mess up search query quoting
					var line = cleanedLines[i].replace('"', '');
					goodLines.push(line);
				}
			}
			return goodLines;
		}
		
		this.recognize = async function (libraryID, queryString) {
			
			Zotero.debug('RecognizePDF: Query string ' + queryString);
			
			let url = 'https://scholar.google.com/scholar?hl=en&as_sdt=0%2C5&q=' + encodeURIComponent(queryString) + '&btnG=';
			
			let xmlhttp = await Zotero.HTTP.request('GET', url, {'responseType': 'document'});
			
			Zotero.debug('RecognizePDF: bbaa (' + xmlhttp.status + ') Got page with title ' + xmlhttp.response.title);
			
			if (Zotero.Utilities.xpath(xmlhttp.response, '//form[@action="Captcha"]').length) {
				Zotero.debug('RecognizePDF: bbaa Found CAPTCHA on page.');
				throw new Zotero.Exception.Alert('recognizePDF.limit');
			}
			
			let doc = xmlhttp.response;
			let deferred = Zotero.Promise.defer();
			let translate = new Zotero.Translate.Web();
			
			translate.setTranslator('57a00950-f0d1-4b41-b6ba-44ff0fc30289');
			translate.setDocument(Zotero.HTTP.wrapDocument(doc, url));
			translate.setHandler('translators', async function (translate, detected) {
				Zotero.debug('RecognizePDF: bbaaa ' + detected.length + ' ' + xmlhttp.status);
				
				if (detected.length) {
					deferred.resolve(await _promiseTranslate(translate, libraryID));
				}
				else {
					deferred.resolve(null);
				}
			});
			translate.getTranslators();
			
			return await deferred.promise;
		};
	};
};
