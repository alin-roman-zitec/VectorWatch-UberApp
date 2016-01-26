CREATE TABLE `Auth` (
  `key` varchar(100) NOT NULL,
  `value` varchar(5000) DEFAULT NULL,
  `count` int(11) NOT NULL DEFAULT '1',
  PRIMARY KEY (`key`)
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
) ENGINE=InnoDB AUTO_INCREMENT=23 DEFAULT CHARSET=utf8;

CREATE TABLE `Settings` (
  `key` varchar(100) NOT NULL,
  `value` varchar(5000) DEFAULT NULL,
  `count` int(11) NOT NULL DEFAULT '1',
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
