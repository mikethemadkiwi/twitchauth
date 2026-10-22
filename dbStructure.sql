CREATE TABLE `twitch` (
	`twitchid` INT(16) NOT NULL DEFAULT -1,
	`createdDT` DATETIME NULL DEFAULT current_timestamp(),
	`updateDT` DATETIME NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
	`State` TINYINT(4) NULL DEFAULT -1,
	`Auth` LONGTEXT NULL DEFAULT NULL COLLATE 'utf8mb4_general_ci',
	`User` LONGTEXT NULL DEFAULT NULL COLLATE 'utf8mb4_general_ci',
	`Channel` LONGTEXT NULL DEFAULT NULL COLLATE 'utf8mb4_general_ci',
	`Ads` LONGTEXT NULL DEFAULT NULL COLLATE 'utf8mb4_general_ci',
	`Meta` LONGTEXT NULL DEFAULT NULL COLLATE 'utf8mb4_general_ci',
	PRIMARY KEY (`twitchid`) USING BTREE
)
COLLATE='utf8mb4_general_ci'
ENGINE=InnoDB
;
