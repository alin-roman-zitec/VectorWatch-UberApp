CREATE TABLE `Auth` (
  `credentialsKey` varchar(45) NOT NULL,
  `authTokens` text NOT NULL,
  PRIMARY KEY (`credentialsKey`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE `LastTripId` (
  `userId` varchar(45) NOT NULL,
  `lastTripId` varchar(45) NOT NULL,
  PRIMARY KEY (`userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE `Mapping` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `string` varchar(100) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `string_UNIQUE` (`string`)
) ENGINE=InnoDB AUTO_INCREMENT=11 DEFAULT CHARSET=utf8;

CREATE TABLE `UserSettings` (
  `channelLabel` varchar(45) NOT NULL,
  `userSettings` text NOT NULL,
  `credentialsKey` varchar(45) DEFAULT NULL,
  `count` int(11) NOT NULL DEFAULT '1',
  PRIMARY KEY (`channelLabel`),
  KEY `auth_idx` (`credentialsKey`),
  CONSTRAINT `auth` FOREIGN KEY (`credentialsKey`) REFERENCES `Auth` (`credentialsKey`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
