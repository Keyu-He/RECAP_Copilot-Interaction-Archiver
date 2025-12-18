import * as vscode from 'vscode';

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

export class Logger {
    private static _outputChannel: vscode.OutputChannel;
    private static _level: LogLevel = LogLevel.INFO;

    public static initialize(context: vscode.ExtensionContext, name: string) {
        this._outputChannel = vscode.window.createOutputChannel(name);
        context.subscriptions.push(this._outputChannel);
    }

    public static get channel(): vscode.OutputChannel {
        return this._outputChannel;
    }

    public static setLevel(level: LogLevel) {
        this._level = level;
    }

    private static log(level: LogLevel, message: string | Error) {
        if (level < this._level) {
            return;
        }

        const timestamp = new Date().toISOString();
        const levelName = LogLevel[level];
        const msgStr = message instanceof Error ? message.message : message;

        // Format: [TIMESTAMP] [LEVEL] Message
        this._outputChannel.appendLine(`[${timestamp}] [${levelName}] ${msgStr}`);

        // Also log to console (optional, but helpful for debugging extension host)
        if (level >= LogLevel.ERROR) {
            console.error(`[${levelName}] ${msgStr}`);
        } else {
            console.log(`[${levelName}] ${msgStr}`);
        }
    }

    public static info(message: string) {
        this.log(LogLevel.INFO, message);
    }

    public static error(message: string | Error) {
        this.log(LogLevel.ERROR, message);
    }

    public static warn(message: string) {
        this.log(LogLevel.WARN, message);
    }

    public static debug(message: string) {
        this.log(LogLevel.DEBUG, message);
    }
}


