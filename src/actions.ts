
import { Lights } from "./lights";
import { Sounds } from "./sounds";
import { Utils } from './utils';
import ChatClient from 'twitch-chat-client';
import websocket from 'websocket';
import fs from 'fs';
import Handlebars from "handlebars";
import say from 'say';

function handleImport(file: string, files: Set<string>)
{
	console.log(`Loading ${file}`);
	let pojo = JSON.parse(fs.readFileSync(file, 'UTF-8'));
	files.add(file);
	return pojo;
}

function handleActionArray(actions: Array<any>, files: Set<string>)
{
	for (let i = 0; i < actions.length; ++i)
	{
		let action = actions[i];
		if ("import" in action)
		{
			let actionsInsert = handleImport(action["import"], files);
			if (!(actionsInsert instanceof Array))
			{
				throw new Error("Imports in the middle of action arrays must be arrays themselves");
			}

			//Handle recursive imports
			handleActionArray(actionsInsert, files);

			actions.splice(i, 1, ...actionsInsert);

			i += actionsInsert.length - 1;
		}
	}
}

function handleOneOf(parent: any, files: Set<string>)
{
	for (let subActionListId in parent.oneOf)
	{
		let subAction = parent.oneOf[subActionListId];
		if ("import" in subAction)
		{
			let newActions = handleImport(subAction["import"], files);

			//Handle recursive imports.
			handleActionArray(newActions, files);

			if (!(newActions instanceof Array))
			{
				throw new Error("Imports in oneOfs must be arrays");
			}
			parent.oneOf[subActionListId] = newActions;
		}
		else if (subAction instanceof Array)
		{
			handleActionArray(subAction, files);
		}
	}
}

export class ActionQueue
{
	events: any;
	queue: Array<any>;
	wsServer: websocket.server;
	currentAction: Promise<any> | null;
	chatFunc: any;
	configFile: string;
	globalsFile: string;
	watchers: Array<fs.FSWatcher>;
	globals: any;

	reload()
	{
		let files: Set<string>;
		files = new Set<string>();

		let config = handleImport(this.configFile, files);
		this.globals = handleImport(this.globalsFile, files);

		//Handle imports.
		for (let eventId in config)
		{
			let event = config[eventId];
			if (event instanceof Array)
			{
				handleActionArray(event, files);
			}
			if ("oneOf" in event)
			{
				handleOneOf(event, files);
			}
			else if ("import" in event)
			{
				//Check for recursive imports.
				let newEvent = handleImport(event["import"], files);
				if (newEvent instanceof Array)
				{
					handleActionArray(newEvent, files);
				}
				if ("oneOf" in newEvent)
				{
					handleOneOf(newEvent, files);
				}
				config[eventId] = newEvent;
			}
			else
			{
				//Named event or Number Event
				for (let subActionListId in event)
				{
					let subAction = event[subActionListId];
					if ("import" in subAction)
					{
						//Check for recursive imports.
						let newEvent = handleImport(subAction["import"], files);
						if (newEvent instanceof Array)
						{
							handleActionArray(newEvent, files);
						}
						if ("oneOf" in newEvent)
						{
							handleOneOf(newEvent, files);
						}
						event[subActionListId] = newEvent;
					}
					else if ("oneOf" in subAction)
					{
						handleOneOf(subAction, files);
					}
					else if (subAction instanceof Array)
					{
						handleActionArray(subAction, files);
					}
				}
			}
		}

		this.events = config;

		let filesArr = Array.from(files);

		for (let w of this.watchers)
		{
			w.close();
		}

		this.watchers = filesArr.map((f) => fs.watch(f, () =>
		{
			try
			{
				console.log("Reloading Config");
				this.reload()
			}
			catch (err)
			{
				console.error("You done broke your json.");
				console.error(err);
			}
		}));

	}

	constructor(configFile: string, globalsFile: string, wsServer: websocket.server, chatFunc: any)
	{
		this.configFile = configFile;
		this.globalsFile = globalsFile;
		this.globals = {};
		this.watchers = [];
		this.reload();

		this.chatFunc = chatFunc;
		this.queue = [];
		this.wsServer = wsServer;
		this.currentAction = null;
	}

	fireEvent(name: string, options: any)
	{
		let event = this.events[name];

		if (!event)
			return false;

		if (options.number)
		{
			//Handle a numberlike event action
			let selected = null;
			for (let key in event)
			{
				let keyNumber = Number(key);
				if (isNaN(keyNumber))
					continue;
				if (options.number > keyNumber)
					selected = event[key];
			}
			if (selected)
			{
				this.pushToQueue(selected, options);
				return true;
			}
		}
		else if (options.name)
		{
			//Handle a namelike event
			let namedEvent = event[options.name];
			if (namedEvent)
			{
				this.pushToQueue(namedEvent, options);
				return true;
			}
		}
		if (event instanceof Array)
		{
			this.pushToQueue(event, options);
			return true;
		}

		return false;
	}

	runNext()
	{
		if (this.queue.length > 0)
		{
			let front = this.queue.shift();
			let frontPromise = this.runAction(front);
			this.currentAction = frontPromise;
			this.currentAction.then(() => this.runNext());
		}
		else
		{
			this.currentAction = null;
		}
	}

	runStartOfQueue()
	{
		if (this.currentAction)
			return;

		if (this.queue.length == 0)
			return;

		let front = this.queue.shift();
		let frontPromise = this.runAction(front);
		this.currentAction = frontPromise;
		this.currentAction.then(() => this.runNext());
	}


	pushToQueue(actions: any, context: any)
	{
		let actionArray = null;
		if (actions instanceof Array)
		{
			actionArray = actions;
		}
		else if ("oneOf" in actions)
		{
			actionArray = actions.oneOf[Math.floor(Math.random() * actions.oneOf.length)]
		}

		if (!(actionArray instanceof Array))
		{
			return;
		}

		this.convertOffsets(actionArray);
		for (let action of actionArray)
		{
			let fullAction = { ...this.globals, ...context, ...action, };
			this.queue.push(fullAction);
		}

		this.runStartOfQueue();
	}

	convertOffsets(actions: Array<any>)
	{
		let timeSinceStart = 0;

		for (let a of actions)
		{
			if (a.timestamp)
			{
				a.beforeDelay = a.timestamp - timeSinceStart;
				timeSinceStart = a.timestamp;
			}
		}
	}

	async runAction(action: any)
	{
		if (action.beforeDelay)
		{
			await Utils.sleep(action.beforeDelay * 1000);
		}
		if (action.sound)
		{
			//Play the sound
			Sounds.playSound(action.sound);
		}
		if (action.light)
		{
			//Change the lights
			Lights.pickColor((action.light.hue / 360) * 65535, action.light.bri, action.light.sat, action.light.on);
		}
		if ("hue" in action)
		{
			//Change the lights through hue setting
			Lights.pickColor((action.hue / 1000) * 65535);
			this.wsServer.broadcast(JSON.stringify({ hue: action.hue / 1000 }));
		}
		if (action.websocket)
		{
			//Broadcast the websocket text
			this.wsServer.broadcast(action.websocket);
		}
		if (action.notification)
		{
			this.wsServer.broadcast(JSON.stringify({
				notification: Handlebars.compile(action.notification)(action)
			}));
		}
		if (action.say)
		{
			this.chatFunc(Handlebars.compile(action.say)(action));
		}
		if (action.speak)
		{
			say.speak(Handlebars.compile(action.speak)(action));
		}
		if (action.delay)
		{
			//Delay the queue before the next action.
			await Utils.sleep(action.delay * 1000);
		}

		return true;
	}
}

