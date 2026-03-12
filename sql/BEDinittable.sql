-- made by NG Sao Keat
-- made by Nagu Adhavan Tabio


-- RESET DATABASE
USE master;
GO

IF DB_ID('BEDProject') IS NOT NULL
BEGIN
    PRINT 'Dropping existing BEDProject database...';
    ALTER DATABASE BEDProject SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE BEDProject;
END

PRINT 'Creating BEDProject database...';
CREATE DATABASE BEDProject;
GO

USE BEDProject;
GO

-- DROP EXISTING TABLES IN CORRECT ORDER
PRINT 'Dropping existing tables if they exist (in correct dependency order)...';

IF OBJECT_ID('dbo.ImageTags', 'U') IS NOT NULL DROP TABLE dbo.ImageTags;
IF OBJECT_ID('dbo.Tags', 'U') IS NOT NULL DROP TABLE dbo.Tags;
IF OBJECT_ID('dbo.Images', 'U') IS NOT NULL DROP TABLE dbo.Images;
IF OBJECT_ID('dbo.Users', 'U') IS NOT NULL DROP TABLE dbo.Users;

PRINT 'Existing tables dropped.';
GO

-- CREATE TABLES

PRINT 'Creating Users table...';
CREATE TABLE Users (
    id INT PRIMARY KEY IDENTITY(1,1),
    userID NVARCHAR(10) NOT NULL UNIQUE,
    username NVARCHAR(50) NOT NULL UNIQUE,
    passwordHash NVARCHAR(255) NOT NULL,
    createdAt DATETIME DEFAULT GETDATE(),
    updatedAt DATETIME DEFAULT GETDATE()
);
GO

PRINT 'Creating Images table...';
CREATE TABLE Images (
    id INT PRIMARY KEY IDENTITY(1,1),
    title NVARCHAR(255),
    filename NVARCHAR(255),
    filePath NVARCHAR(255),
    dateAdded DATETIME DEFAULT GETDATE(),
    uploader NVARCHAR(100) DEFAULT 'administrator',  -- TODO: ideally FK to Users(id)
    filesize INT NULL,       -- in bytes
    width INT NULL,
    height INT NULL,
    status NVARCHAR(50) DEFAULT 'Pending',
    description NVARCHAR(MAX) NULL
);
GO

PRINT 'Creating Tags table...';
CREATE TABLE Tags (
    id INT PRIMARY KEY IDENTITY(1,1),
    name NVARCHAR(100) UNIQUE NOT NULL,
    category NVARCHAR(50) NULL,
    post_count INT DEFAULT 0
);
GO

PRINT 'Creating ImageTags table...';
CREATE TABLE ImageTags (
    imageId INT NOT NULL,
    tagId INT NOT NULL,
    PRIMARY KEY (imageId, tagId),
    FOREIGN KEY (imageId) REFERENCES Images(id) ON DELETE CASCADE,
    FOREIGN KEY (tagId) REFERENCES Tags(id) ON DELETE CASCADE
);
GO

-- SEED DATA
PRINT 'Inserting initial data into Tags...';
INSERT INTO Tags (name, category) VALUES
('landscape', 'General'),
('portrait', 'General'),
('nature', 'General'),
('city', 'General'),
('animal', 'General'),
('digital art', 'General');
GO

PRINT 'Inserting initial data into Images...';
INSERT INTO Images (title, filename, filePath, uploader, filesize, width, height, status) VALUES
('Sunset Over Hills', 'sunset.jpg', '/images/sunset.jpg', 'administrator', 204800, 1920, 1080, 'Approved'),
('Urban Skyline', 'city.jpg', '/images/city.jpg', 'administrator', 153600, 1280, 720, 'Approved'),
('Tiger in Forest', 'tiger.jpg', '/images/tiger.jpg', 'administrator', 307200, 2560, 1440, 'Approved');
GO

PRINT 'Inserting image-tag relationships into ImageTags...';
INSERT INTO ImageTags (imageId, tagId) VALUES
(1, 1), -- sunset - landscape
(2, 4), -- city - city
(3, 5), -- tiger - animal
(3, 3); -- tiger - nature
GO

PRINT 'Inserting sample users...';
--Dummy data for Users
INSERT INTO Users (userID, username, passwordHash)
VALUES 
('U12350', 'jack434', '$2b$10$F09fi3F111qCS0SFafWyf.vVqb/HD0Rw7Be6hyRu8Yot0Ax/FO0fi'),
('U12351', 'alex999', '$2b$10$2F7HGnRSOMQfd6CbzV1Tye1iJdjGhfXDVXoWsLeO/0mzCKy/nk3xS'),
('U12352', 'lisaadmin', '$2b$10$EoIvjA2b3eR1ZUWNFLEpT.ThFOzTpQYBv9PnpgU3BbCt.QhWbSaMq');
--password is password1, password2, password3
GO

-- Confirm tables created
PRINT 'Verifying all base tables:';
SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE';
GO

-- CREATE SQL LOGIN AND DATABASE USER

PRINT 'Dropping existing SQL login (imagesapi_user) if it exists...';
USE master;
IF EXISTS (SELECT * FROM sys.sql_logins WHERE name = 'imagesapi_user')
BEGIN
    DROP LOGIN imagesapi_user;
    PRINT 'Old login dropped.';
END
GO

PRINT 'Creating new SQL login (imagesapi_user)...';
CREATE LOGIN imagesapi_user WITH PASSWORD = 'imagesapi_user';
GO

PRINT 'Switching to BEDProject to create user mapped to login...';
USE BEDProject;
GO

PRINT 'Dropping existing database user (imagesapi_user) if exists...';
IF EXISTS (SELECT * FROM sys.database_principals WHERE name = 'imagesapi_user')
BEGIN
    DROP USER imagesapi_user;
    PRINT 'Old user dropped.';
END
GO

PRINT 'Creating database user for login...';
CREATE USER imagesapi_user FOR LOGIN imagesapi_user;
GO

PRINT 'Granting db_datareader and db_datawriter roles to imagesapi_user...';
ALTER ROLE db_datareader ADD MEMBER imagesapi_user;
ALTER ROLE db_datawriter ADD MEMBER imagesapi_user;
GO

PRINT 'imagesapi_user login and database user created and granted permissions successfully.';
GO
