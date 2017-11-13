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

Zotero.RecognizePDF = new function () {
	const OFFLINE_CHECK_DELAY = 60 * 1000;
	
	this.ROW_QUEUED = 1;
	this.ROW_PROCESSING = 2;
	this.ROW_FAILED = 3;
	this.ROW_SUCCEEDED = 4;
	
	this.getRows = getRows;
	this.getTotal = getTotal;
	this.getProcessed = getProcessed;
	this.cancel = cancel;
	this.canRecognize = canRecognize;
	this.recognizeItems = recognizeItems;
	this.addListener = addListener;
	this.removeListener = removeListener;
	
	let _listeners = {};
	let _rows = [];
	let _queue = [];
	let _queueProcessing = false;
	
	function addListener(name, callback) {
		_listeners[name] = callback;
	}
	
	function removeListener(name) {
		delete _listeners[name];
	}
	
	/**
	 * Checks whether a given PDF could theoretically be recognized
	 * @returns {Boolean} True if the PDF can be recognized, false if it cannot be
	 */
	function canRecognize(/**Zotero.Item*/ item) {
		return item.attachmentMIMEType
			&& item.attachmentMIMEType === 'application/pdf'
			&& item.isTopLevelItem();
	}
	
	/**
	 * Retrieves metadata for the PDF(s) selected in the Zotero Pane, placing the PDFs as a children
	 * of the new items
	 */
	function recognizeItems(items) {
		for (let i = 0; i < items.length; i++) {
			_addItem(items[i]);
		}
		_processQueue();
	}
	
	function getRows() {
		return _rows;
	}
	
	function getTotal() {
		return _rows.length;
	}
	
	function getProcessed() {
		let processed = 0;
		for (let i = 0; i < _rows.length; i++) {
			let row = _rows[i];
			if (row.status > Zotero.RecognizePDF.ROW_PROCESSING) {
				processed++;
			}
		}
		return processed;
	}
	
	function cancel() {
		_queue = [];
		_rows = [];
		if (_listeners['onEmpty']) {
			_listeners['onEmpty']();
		}
	}
	
	function _addItem(item) {
		for (let i = 0; i < _rows.length; i++) {
			let row = _rows[i];
			if (row.id === item.id) {
				if (row.status > Zotero.RecognizePDF.ROW_PROCESSING) {
					_deleteRow(row.id);
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
		
		_rows.push(row);
		_queue.push(item.id);
		
		if (_listeners['onRowAdded']) {
			_listeners['onRowAdded'](row);
		}
		
		if (_listeners['onNonEmpty'] && _rows.length===1) {
			_listeners['onNonEmpty']();
		}
	}
	
	function _updateRow(itemID, status, message) {
		for (let i = 0; i < _rows.length; i++) {
			let row = _rows[i];
			if (row.id === itemID) {
				row.status = status;
				row.message = message;
				if (_listeners['onRowUpdated']) {
					_listeners['onRowUpdated']({
						id: row.id,
						status,
						message: message || ''
					});
				}
				return;
			}
		}
	}
	
	function _deleteRow(itemID) {
		for (let i = 0; i < _rows.length; i++) {
			let row = _rows[i];
			if (row.id === itemID) {
				_rows.splice(i, 1);
				if (_listeners['onRowDeleted']) {
					_listeners['onRowDeleted']({
						id: row.id
					});
				}
				return;
			}
		}
	}
	
	async function _processQueue() {
		await Zotero.Schema.schemaUpdatePromise;
		
		if (_queueProcessing) return;
		_queueProcessing = true;
		
		while (1) {
			if (Zotero.HTTP.browserIsOffline()) {
				await Zotero.Promise.delay(OFFLINE_CHECK_DELAY);
				continue;
			}
			
			let itemID = _queue.shift();
			if (!itemID) break;
			
			_updateRow(itemID, Zotero.RecognizePDF.ROW_PROCESSING, 'processing');
			
			try {
				let newItem = await _processItem(itemID);
				
				if (newItem) {
					_updateRow(itemID, Zotero.RecognizePDF.ROW_SUCCEEDED, newItem.getField('title'));
				}
				else {
					_updateRow(itemID, Zotero.RecognizePDF.ROW_FAILED, Zotero.getString('recognizePDF.noMatches'));
				}
			}
			catch (e) {
				Zotero.logError(e);
				
				_updateRow(
					itemID,
					Zotero.RecognizePDF.ROW_FAILED,
					e instanceof Zotero.Exception.Alert
						? e.message
						: Zotero.getString('recognizePDF.error')
				);
				
				_queue.push(itemID);
				await Zotero.Promise.delay(1000);
			}
		}
		
		_queueProcessing = false;
	}
	
	async function _processItem(itemID) {
		let item = await Zotero.Items.getAsync(itemID);
		
		if (!item) throw new Zotero.Exception.Alert('recognizePDF.fileNotFound');
		
		if (item.parentItemID) throw new Zotero.Exception.Alert('recognizePDF.fileNotFound');
		
		let newItem = await _recognize(item);
		
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
		
		return null;
	}
	
	/**
	 * Retrieves metadata for a PDF and saves it as an item
	 *
	 * @param {Zotero.Item} item
	 * @return {Promise} A promise resolved when PDF metadata has been retrieved
	 */
	async function _recognize(item) {
		
		let file = item.getFile();
		
		let hash = await item.attachmentHash;
		let fulltext = await _extractText(file, 10);
		
		let libraryID = item.libraryID;
		
		// Look for DOI - Use only first two pages
		let allText = fulltext;
		let pages = fulltext.split('\f');
		let firstChunk = pages.slice(0,2).join('\f');
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
				Zotero.debug('RecognizePDF: ' + e);
			}
		}
		else {
			Zotero.debug('RecognizePDF: No ISBN found in text');
		}
		
		newItem = await _recognizerServer.findItem(fulltext, hash, libraryID);
		if (newItem) return newItem;
		
		return null;
	}
	
	/**
	 * Get text from a PDF
	 * @param {nsIFile} file PDF
	 * @param {Number} pages Number of pages to extract
	 * @return {Promise}
	 */
	function _extractText(file, pages) {
		var cacheFile = Zotero.File.pathToFile(Zotero.DataDirectory.dir);
		cacheFile.append("recognizePDFcache.txt");
		if(cacheFile.exists()) {
			cacheFile.remove(false);
		}
		
		var {exec, args} = Zotero.Fulltext.getPDFConverterExecAndArgs();
		args.push('-enc', 'UTF-8', '-l', pages, file.path, cacheFile.path);
		
		Zotero.debug("RecognizePDF: Running " + exec.path + " " + args.map(arg => "'" + arg + "'").join(" "));
		
		return Zotero.Utilities.Internal.exec(exec, args).then(function() {
			if(!cacheFile.exists()) {
				throw new Zotero.Exception.Alert("recognizePDF.couldNotRead");
			}
			
			try {
				var inputStream = Components.classes["@mozilla.org/network/file-input-stream;1"]
					.createInstance(Components.interfaces.nsIFileInputStream);
				inputStream.init(cacheFile, 0x01, 0o664, 0);
				try {
					var intlStream = Components.classes["@mozilla.org/intl/converter-input-stream;1"]
						.createInstance(Components.interfaces.nsIConverterInputStream);
					intlStream.init(inputStream, "UTF-8", 65535,
						Components.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
					intlStream.QueryInterface(Components.interfaces.nsIUnicharLineInputStream);
					
					// get the lines in this sample
					var lines = [], str = {};
					while(intlStream.readLine(str)) {
							lines.push(str.value);
					}
					
					return lines.join('\n');
				} finally {
					inputStream.close();
				}
			} finally {
				cacheFile.remove(false);
			}
			
			return lines;
		}, function() {
			throw new Zotero.Exception.Alert("recognizePDF.couldNotRead");
		});
	}
	
	/**
	 * Attach appropriate handlers to a Zotero.Translate instance and begin translation
	 * @return {Promise}
	 */
	async function _promiseTranslate(translate, libraryID) {
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
	}
	
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
	
	let _recognizerServer = new function () {
		this.findItem = findItem;
		
		async function findItem(fulltext, hash, libraryID) {
			
			let res = await _query(hash, fulltext);
			if (!res) return null;
			
			for (let i = 0; i < res.identifiers.length; i++) {
				let [type, identifier] = res.identifiers[i].split(':');
				if (type === 'doi' && !res.title) {
					Zotero.debug('RecognizePDF: Getting metadata by DOI');
					let translateDOI = new Zotero.Translate.Search();
					translateDOI.setTranslator('11645bd1-0420-45c1-badb-53fb41eeb753');
					translateDOI.setSearch({'itemType': 'journalArticle', 'DOI': identifier});
					try {
						let newItem = await _promiseTranslate(translateDOI, libraryID);
						if (!newItem.abstractNote && res.abstract) {
							newItem.setField('abstractNote', res.abstract);
						}
						newItem.saveTx();
						return newItem;
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
							if (_validateMetadata(fulltext, translatedItems[0].title)) {
								let newItem = new Zotero.Item;
								newItem.fromJSON(translatedItems[0]);
								newItem.libraryID = libraryID;
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
						if (_validateMetadata(fulltext, translatedItem.title)) {
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
		}
		
		async function _query(hash, fulltext) {
			let body = JSON.stringify({
				hash: hash,
				text: fulltext
			});
			
			let uri = 'http://52.202.100.87:8003/recognize';
			
			let req = await Zotero.HTTP.request(
				'POST',
				uri,
				{
					successCodes: [200],
					headers: {
						'Content-Type': 'application/json'
					},
					debug: true,
					body: body
				}
			);
			
			let json = JSON.parse(req.responseText);
			if (json.title || json.identifiers) {
				return json;
			}
			
			return null;
		}
		
		function _processText(text) {
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
		
		function _validateMetadata(fulltext, title) {
			let processedFulltext = _processText(fulltext);
			
			title = Zotero.Utilities.unescapeHTML(title);
			
			let columnIndex = title.indexOf(':');
			if (columnIndex >= 30) title = title.slice(0, columnIndex);
			let processedTitle = _processText(title);
			
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
	};
};
