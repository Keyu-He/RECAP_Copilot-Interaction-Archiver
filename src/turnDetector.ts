import * as vscode from 'vscode';

enum TurnState {
    IDLE = 'IDLE',
    USER_TURN_STARTED = 'USER_TURN_STARTED',
    ASSISTANT_RESPONDING = 'ASSISTANT_RESPONDING',
    QUIET_PERIOD = 'QUIET_PERIOD'
}

export class TurnDetector {
    private state: TurnState = TurnState.IDLE;
    private currentTurnIndex: number = -1;
    private lastProcessedLineCount: number = 0;
    private quietTimer: NodeJS.Timeout | undefined;
    private onTurnComplete: (turnIndex: number, debugTimestamp?: string) => Promise<void>;
    private quietPeriodMs: number;

    constructor(onTurnComplete: (turnIndex: number, debugTimestamp?: string) => Promise<void>) {
        this.onTurnComplete = onTurnComplete;
        const config = vscode.workspace.getConfiguration('copilotArchiver');
        this.quietPeriodMs = config.get<number>('quietPeriodMs', 7000);
    }

    processLogLines(lines: string[]) {
        // Only process new lines
        const newLines = lines.slice(this.lastProcessedLineCount);
        if (newLines.length === 0) {
            return;
        }

        this.lastProcessedLineCount = lines.length;

        for (const line of newLines) {
            this.processLine(line);
        }

        // Reset quiet timer on any new activity
        this.resetQuietTimer();
    }

    // New: process only new lines provided by caller (no internal cursor tracking)
    processNewLines(newLines: string[]) {
        if (newLines.length === 0) {
            return;
        }
        for (const line of newLines) {
            this.processLine(line);
        }
        this.resetQuietTimer();
    }

    private processLine(line: string) {
        const hasUserRequest = line.includes('<userRequest>');
        const hasResponseComplete = line.includes('request.response:') && line.includes('took');

        switch (this.state) {
            case TurnState.IDLE:
                if (hasUserRequest) {
                    this.currentTurnIndex++;
                    this.state = TurnState.USER_TURN_STARTED;
                    console.log(`Turn ${this.currentTurnIndex} started (user request detected)`);
                }
                break;

            case TurnState.USER_TURN_STARTED:
                if (hasResponseComplete) {
                    this.state = TurnState.ASSISTANT_RESPONDING;
                    console.log(`Turn ${this.currentTurnIndex}: Assistant started responding`);
                }
                break;

            case TurnState.ASSISTANT_RESPONDING:
                if (hasResponseComplete) {
                    // More responses, stay in this state
                    console.log(`Turn ${this.currentTurnIndex}: Additional response detected`);
                }
                // Quiet timer will trigger transition to QUIET_PERIOD
                break;

            case TurnState.QUIET_PERIOD:
                // If we see any new activity, go back to ASSISTANT_RESPONDING
                if (hasResponseComplete) {
                    this.state = TurnState.ASSISTANT_RESPONDING;
                    console.log(`Turn ${this.currentTurnIndex}: Resumed responding after quiet period`);
                } else if (hasUserRequest) {
                    // New turn started before completing previous one
                    // Complete the previous turn and start new one
                    this.completeTurn();
                    this.currentTurnIndex++;
                    this.state = TurnState.USER_TURN_STARTED;
                    console.log(`Turn ${this.currentTurnIndex} started (interrupted previous turn)`);
                }
                break;
        }
    }

    private resetQuietTimer() {
        // Clear existing timer
        if (this.quietTimer) {
            clearTimeout(this.quietTimer);
            this.quietTimer = undefined;
        }

        // Only set timer if we're in a state where turn completion is relevant
        if (this.state === TurnState.ASSISTANT_RESPONDING) {
            this.quietTimer = setTimeout(() => {
                this.state = TurnState.QUIET_PERIOD;
                console.log(`Turn ${this.currentTurnIndex}: Entering quiet period`);

                // Start another timer for final completion
                this.quietTimer = setTimeout(() => {
                    this.completeTurn();
                }, this.quietPeriodMs);
            }, this.quietPeriodMs / 2); // First wait half the period, then full period
        }
    }

    private completeTurn() {
        if (this.state === TurnState.IDLE || this.currentTurnIndex < 0) {
            return; // Nothing to complete
        }

        console.log(`Turn ${this.currentTurnIndex} complete`);

        // Trigger snapshot
        this.onTurnComplete(this.currentTurnIndex);

        // Reset to idle state
        this.state = TurnState.IDLE;

        // Clear any existing timer
        if (this.quietTimer) {
            clearTimeout(this.quietTimer);
            this.quietTimer = undefined;
        }
    }

    stop() {
        if (this.quietTimer) {
            clearTimeout(this.quietTimer);
            this.quietTimer = undefined;
        }
    }
}
