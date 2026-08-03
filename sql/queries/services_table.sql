
IF OBJECT_ID('dbo.Services', 'U') IS NOT NULL DROP TABLE dbo.Services;


CREATE TABLE Services (
    id INT PRIMARY KEY IDENTITY(1,1),
    name NVARCHAR(100) NOT NULL,
    description NVARCHAR(255) NULL,
    type NVARCHAR(50) NOT NULL,
    target NVARCHAR(500) NOT NULL,
    iconPath NVARCHAR(255) NULL,
    enabled BIT DEFAULT 1,
    sortOrder INT DEFAULT 0,
    createdAt DATETIME DEFAULT GETDATE()
);


PRINT 'Inserting Services...';
INSERT INTO Services (name, description, type, target, iconPath) VALUES
('Wikipedia', 'Online encyclopedia', 'External', 'https://wikipedia.org', '/assets/icons/wikipedia.png'),
('Danbooru', 'Image board for anime art', 'External', 'https://danbooru.donmai.us', '/assets/icons/danbooru.png'),
('Pixiv', 'Japanese online community for artists', 'External', 'https://www.pixiv.net', '/assets/icons/pixiv.png'),
('YouTube', 'Video sharing platform', 'External', 'https://www.youtube.com', '/assets/icons/youtube.png'),
('GitHub', 'Code hosting platform', 'External', 'https://github.com', '/assets/icons/github.png');
GO