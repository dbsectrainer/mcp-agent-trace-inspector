import { DatabaseSync } from "node:sqlite";
export interface AlertChannels {
    slackWebhook?: string;
    genericWebhook?: string;
}
export interface AlertRule {
    type: "latency" | "error_rate" | "cost";
    threshold: number;
}
export interface AlertFired {
    rule: AlertRule;
    value: number;
    message: string;
}
export declare function checkAndAlert(db: DatabaseSync, rules: AlertRule[], channels: AlertChannels): Promise<AlertFired[]>;
export declare function initAlertRulesTable(db: DatabaseSync): void;
export declare function saveAlertRules(db: DatabaseSync, rules: AlertRule[]): void;
export declare function loadAlertRules(db: DatabaseSync): AlertRule[];
